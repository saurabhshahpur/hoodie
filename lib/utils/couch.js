var async = require('async')
var prmpt = require('prompt')
var request = require('request')

var credentials = require('../couchdb/credentials')
var util = require('./index')

/**
 * Checks if CouchDB is in admin party mode
 */

exports.isAdminParty = function (env_config, callback) {
  request.get(
    env_config.couch.url + '/_users/_all_docs',
    function (err, res) {
    if (err) {
      return callback(err)
    }

    callback(null, res.statusCode === 200)
  })
}

/**
 * Creates a Pocket admin user
 */

exports.saveAdminUser = function (env_config, couch_user, couch_pwd, user, callback) {
  request({
    url: env_config.couch.url + '/_config/admins/' + encodeURIComponent(user.name),
    method: 'PUT',
    body: user.password,
    json: true,
    auth: {
      user: couch_user,
      pass: couch_pwd
    }
  }, callback)
}

/**
 * Prompts the user to create a Hoodie admin account
 */

exports.promptAdminUser = function (callback) {
  if (process.env.CI) {
    // hardcode username as admin for now
    var result = {}
    result.name = 'admin'
    result.password = 'travis-ci'
    return callback(null, result)
  }

  prmpt.get({
    properties: {
      password: {
        description: 'Please set an admin password ',
        required: true,
        hidden: true
      }
    }
  }, function (err, result) {
    // hardcode username as admin for now
    result.name = 'admin'
    return callback(err, result)
  })
}

/**
 * Checks if CouchDB is in admin party mode
 */

exports.checkCouchCredentials = function (env_config, callback) {
  var couchdb = credentials.get(env_config.hoodie.data_path)

  if (!couchdb.username || !couchdb.password) {
    // missing from config, return a failure
    return callback(null, false)
  }

  request({
    url: env_config.couch.url + '/_users/_all_docs',
    method: 'GET',
    auth: {
      user: couchdb.username,
      pass: couchdb.password
    }
  }, function (err, res) {
    if (err) {
      return callback(err)
    }
    callback(null, res.statusCode === 200)
  })
}

/**
 * Check that the stored couchdb credentials still work, prmpt the user
 * to update them if not.
 */

exports.updateCouchCredentials = function (env_config, callback) {
  exports.checkCouchCredentials(env_config, function (err, admin) {
    if (err) {
      return callback(err)
    }

    if (admin) {
      // stored admin user still works
      return callback()
    }

    // stored admin credentials out of date
    exports.promptCouchCredentials(function (err, user, pass) {
      if (err) {
        return callback(err)
      }

      credentials.set(env_config.hoodie.data_path, user, pass)

      // make sure the new credentials work
      exports.updateCouchCredentials(env_config, callback)
    })
  })
}

/**
 * Ask the user for the CouchDB admin credentials
 */

exports.promptCouchCredentials = function (callback) {
  console.log('Please enter your CouchDB _admin credentials:')
  prmpt.get({
    properties: {
      name: {
        description: 'Username',
        required: true
      },
      password: {
        description: 'Password',
        required: true,
        hidden: true
      }
    }
  }, function (err, result) {
    if (err) {
      return callback(err)
    }
    return callback(null, result.name, result.password)
  })
}

/**
 * Returns a function which will create the named database
 */

exports.createDB = function (name) {
  return function (env_config, username, password, callback) {
    var auth = {
      user: username,
      pass: password
    }

    async.series([
      async.apply(request, {
        url: env_config.couch.url + '/' + encodeURIComponent(name),
        method: 'PUT',
        auth: auth
      }),
      async.apply(request, {
        url: env_config.couch.url + '/' + encodeURIComponent(name) + '/_security',
        method: 'PUT',
        auth: auth,
        json: true,
        body: {
          admins: {roles: ['_admin']},
          members: {roles: ['_admin']}
        }
      })
    ], callback)
  }
}

/**
 * Sets the admin password on CouchDB to a newly generated password
 */

exports.createCouchCredentials = function (env_config, callback) {
  var username = '_hoodie'
  var password = util.generatePassword()

  request({
    url: env_config.couch.url + '/_config/admins/' + username,
    method: 'PUT',
    body: JSON.stringify(password)
  }, function (err) {
    if (err) return callback(err)

    credentials.set(env_config.hoodie.data_path, username, password)
    callback(null)
  })
}

/**
 * Creates plugin DB
 */

exports.setupPlugins = function (env_config, callback) {
  var couchdb = credentials.get(env_config.hoodie.data_path)

  exports.createDB('plugins')(env_config, couchdb.username, couchdb.password, callback)
}

/**
 * Create app DB and config doc
 */

exports.setupApp = function (env_config, callback) {
  var couchdb = credentials.get(env_config.hoodie.data_path)

  async.applyEachSeries([
    exports.createDB('app'),
    exports.createAppConfig
  ], env_config, couchdb.username, couchdb.password, callback)
}

/**
 * Creates a CouchDB user with the appropriate roles to be an admin of
 * this Hoodie instance
 */

exports.createAdminUser = function (env_config, callback) {
  var couchdb = credentials.get(env_config.hoodie.data_path)

  if (env_config.admin_password) {
    var user = {
      name: 'admin',
      password: env_config.admin_password
    }

    return exports.saveAdminUser(env_config, couchdb.username, couchdb.password, user, callback)
  }

  exports.promptAdminUser(function (err, user) {
    if (err) {
      return callback(err)
    }

    exports.saveAdminUser(env_config, couchdb.username, couchdb.password, user, callback)
  })
}

/**
 * Create appconfig doc in plugins database
 */

exports.createAppConfig = function (env_config, username, password, callback) {
  var body = JSON.stringify({
    _id: 'config',
    config: {},
    name: env_config.app.name,
    createdAt: new Date(),
    updatedAt: new Date()
  })

  request({
    url: env_config.couch.url + '/app/config',
    method: 'PUT',
    auth: {
      user: username,
      pass: password
    },
    body: body
  }, callback)
}

/**
 * Changes the CouchDB configuration
 */
exports.setConfig = function (env_config, section, key, value, callback) {
  var couchdb = credentials.get(env_config.hoodie.data_path)

  request({
    url: env_config.couch.url + '/_config/' + section + '/' + key,
    method: 'PUT',
    auth: {
      user: couchdb.username,
      pass: couchdb.password
    },
    body: JSON.stringify(value)
  }, callback)
}

/**
 * Find CouchDB locations
 */

exports.getCouch = function (env) {
  if (!env.COUCH_URL) {
    return {
      run: true // start local couch
    }
  }

  // if COUCH_URL is set in the environment,
  // we don't attempt to start our own instance
  // of CouchDB, but just use the one provided
  // to us there.

  return {
    url: env.COUCH_URL.replace(/\/$/, ''),
    run: false
  }
}