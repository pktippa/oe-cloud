var logger = require('oe-logger');
var log = logger('failsafe-observer-mixin');
var async = require('async');
var UUID = require('node-uuid');
var eventHistroyManager = require('./../../lib/event-history-manager.js');
var enableEventHistoryManager = require('./../../server/config.json').enableEventHistoryManager;
var observerTypes = ['after save', 'after delete'];

module.exports = function failsafeObserverMixin(Model) {
  if (enableEventHistoryManager === false) {
    return;
  }
  if (Model.modelName === 'BaseEntity') {
    return;
  }

  var FailSafeObserver = function (fn) {
    var _fn = fn;
    var _id = UUID.v4();
    var _name = fn.name;

    this.execute = function (modelName, version, operation, ctx, next) {
      _fn(ctx, function (error) {
        if (!error) {
          if (version) {
            eventHistroyManager.update(modelName, version, operation, _id);
          }
          next();
        } else {
          log.error(ctx.options, 'failSafe observer: ', _fn.name, ' failed with error: ', error.message);
          next(error);
        }
      });
    };

    this.getId = function () {
      return _id;
    };

    this.getName = function () {
      return _name;
    };
  };

  Model._fsObservers = {};

  Model.defineProperty('_processed', {
    type: 'boolean',
    default: false
  });

  Model.defineProperty('_fsCtx', {
    type: 'string'
  });

  if (Model.definition.settings.hidden) {
    Model.definition.settings.hidden = Model.definition.settings.hidden.concat(['_fsCtx', '_processed']);
  } else {
    Model.definition.settings.hidden = ['_fsCtx', '_processed'];
  }

  Model.failSafeObserve = function (eventName, observer) {
    if (!(observer instanceof FailSafeObserver)) {
      var err = new Error('observer should be an instanceof FailSafeObserver');
      err.retriable = false;
      throw err;
    }

    if (!this._fsObservers[eventName]) {
      this._fsObservers[eventName] = { 'observers': [], 'observerIds': [] };
    }

    this._fsObservers[eventName].observers.push(observer);
    this._fsObservers[eventName].observerIds.push(observer.getId());
  };

  function converteObservers(type) {
    if (typeof Model._observers[type] !== 'undefined') {
      Model._observers[type].forEach(function (observer) {
        var failSafeObserver = new FailSafeObserver(observer);
        Model.failSafeObserve(type, failSafeObserver);
      });
      Model._observers[type] = [];
    }
  }

  function changeObserve() {
    var _observe = Model.observe;
    Model.observe = function (operation, method) {
      if (observerTypes.find(op => op === operation) && !method.name.startsWith('_failsafeObserver')) {
        var failSafeObserver = new FailSafeObserver(method);
        Model.failSafeObserve(operation, failSafeObserver);
      } else {
        _observe.call(this, operation, method);
      }
    };
  }

  Model.evObserve('before save', failsafeObserverBeforeSave);
  Model.evObserve('before delete', failsafeObserverBeforeDelete);

  observerTypes.forEach(type => converteObservers(type));
  changeObserve();

  Model.evObserve('after save', _failsafeObserverAfterSave);
  Model.evObserve('after delete', _failsafeObserverAfterDelete);
};

function failsafeObserverBeforeDelete(ctx, next) {
  var version;
  if (typeof ctx.instance !== 'undefined') {
    version = ctx.instance._version;
    ctx.instance._fsCtx = JSON.stringify(ctx.options);
  } else if (typeof ctx.data !== 'undefined') {
    version = ctx.data._version;
  }
  if (!version) {
    return next();
  }
  eventHistroyManager.create(ctx.Model.modelName, version, 'after delete', ctx);
  next();
}

function failsafeObserverBeforeSave(ctx, next) {
  var version;
  if (typeof ctx.instance !== 'undefined') {
    version = ctx.instance._version;
    ctx.instance._fsCtx = JSON.stringify(ctx.options);
  } else if (typeof ctx.data !== 'undefined') {
    version = ctx.data._version;
  }
  if (!version) {
    return next();
  }

  eventHistroyManager.create(ctx.Model.modelName, version, 'after save', ctx);
  next();
}

function _failsafeObserverAfterSave(ctx, next) {
  invokeFailsafeObserver(ctx, 'after save', next);
}

function _failsafeObserverAfterDelete(ctx, next) {
  invokeFailsafeObserver(ctx, 'after delete', next);
}

function invokeFailsafeObserver(ctx, operation, next) {
  if (ctx.Model.definition.settings.mixins.FailsafeObserverMixin) {
    notifyFailsafeObservers(ctx.Model, ctx.Model, operation, ctx, function (err) {
      var version = (ctx.instance && ctx.instance._version) || (ctx.data && ctx.data._version);
      if (!err) {
        if (version) {
          eventHistroyManager.remove(ctx.Model.modelName, version, operation);
        }
        return next();
      }
      if (err.retriable === false) {
        if (version) {
          eventHistroyManager.remove(ctx.Model.modelName, version, operation, 'error: ' + err.message + ' is not retriable.');
        }
        return next(err);
      }
      return next();
    });
  } else {
    return next();
  }
}

function notifyFailsafeObservers(childModel, model, operation, ctx, cb) {
  notifyBaseFailsafeObservers(childModel, model, operation, ctx, function (error) {
    if (error) {
      return cb(error);
    }
    var fsObservers = (model._fsObservers[operation] && model._fsObservers[operation].observers) || [];
    var version = (ctx.instance && ctx.instance._version) || (ctx.data && ctx.data._version);
    async.eachSeries(fsObservers, function notifySingleObserver(fn, callback) {
      var retval = fn.execute(childModel.modelName, version, operation, ctx, callback);

      if (retval && typeof retval.then === 'function') {
        retval.then(function () {
          callback();
        }, callback);
      }
    }, function (err) {
      if (err) {
        cb(err);
      } else {
        cb();
      }
    });
  });
}

function notifyBaseFailsafeObservers(childModel, model, operation, ctx, cb) {
  if (model.base && model.base._fsObservers) {
    notifyFailsafeObservers(childModel, model.base, operation, ctx, cb);
  } else {
    cb();
  }
}
