'use strict';

module.exports = function ($) {

  var Base = $.require('service');

  var NestedSetService = function NestedSetService(Model) {
    this.super_.super_ = Base.prototype;

    if (!!Model.schema.paths.organization) {
      // Add organization to the fields settings
      var fields = this.defaultFields.split(' ');
      if (fields.indexOf('organization') < 0) {
        fields.push('organization');
        this.defaultFields = fields.join(' ');
      }
    }

    this.CACHE_KEY = Math.random();

    Base.call(this, Model);
  };

  $.utils.inherits(NestedSetService, Base);

  $.utils.extend(NestedSetService.prototype, {

    defaultFields: 'name description parentId use_counter',
    defaultSort:   'name',
    updateFields:  'name description parentId',
    createFields:  'name description parentId',

    subFieldName: 'children',
    defaultLimit: 0,

    buildTree: function buildTree(root, records) {
      var self = this;
      var children = records.filter(function (item) {
        return item.parentId && item.parentId.equals(root._id);
      });

      if (children.length === 0) {
        return root;
      }

      root[self.subFieldName] = [];
      children.forEach(function (item) {
        root[self.subFieldName].push(self.buildTree(item, records));
      });

      return root;
    },

    create: function create(req, doc, fn) {
      var self = this;

      async.series([function (callback) {
        // first, validate for multiple root nodes
        if (doc.parentId) {
          return callback();
        }
        else {
          var params = {
            conditions: { parentId: { $exists: false } }
          };
          self.findOne(req, params, function (err, doc) {
            if (err) {
              return callback(err);
            }

            if (doc) {
              return callback(new Error('root_node_already_exists'));
            }
            return callback();
          });
        }
      }, function (callback) {
        // validate parent
        if (!doc.parentId) {
          return callback();
        }

        self.findById(req, doc.parentId, function (err, doc) {
          if (err) {
            return callback(err);
          }
          if (!doc) {
            return callback(new Error('invalid_id_provided'));
          }
          return callback();
        });
      }, function (callback) {
        // create node and rebuild tree
        Base.prototype.create.call(self, req, doc, function (err, newDoc) {
          if (err) {
            return callback(err);
          }
          self.rebuildTree(req, function (err) {
            if (err) {
              return callback(err);
            }
            return self.findById(req, newDoc._id, callback);
          });
        });
      }], function (err, result) {
        return fn(err, result[2]);
      });
    },

    copy: function copy(req, doc, newParentId, fn) {
      newParentId = newParentId || doc.parentId;
      if (!newParentId) {
        return new Error('no_id_provided');
      }
      var self = this;
      async.waterfall([function (callback) {
        // find the node and its descendants
        self.findOne(req, {
          conditions: { _id: doc._id },
          fields: self.defaultFields.concat(' rgt lft')
        }, function (err, doc) {
          if (err) {
            return callback(err);
          }
          var params = {
            conditions: { lft: { $gte: doc.lft }, rgt: { $lte: doc.rgt } },
            fields: self.defaultFields.concat(' rgt lft')
          };

          self.find(req, params, function (err, docs) {
            return callback(err, docs);
          });
        });
      }, function (docs, callback) {
        // clone and create new models and set new parentId references
        var modelMap = docs.reduce(function (map, sub) {
          var clone = $.utils.clone(sub);
          delete clone._id;
          map[sub._id] = new self._model(clone);
          return map;
        }, {});

        for (var key in modelMap) {
          var model = modelMap[key];
          // if model has a parentId value
          if (model.parentId) {
            // then replace it with cloned parent's id.
            if (modelMap[model.parentId]) {
              model.parentId = modelMap[model.parentId]._id;
            }
            else {
              // or if parentId does not resolve in modelMap, its probably the top
              // level node in the tree, so set its parentId value to that of new parent
              model.parentId = newParentId;
            }
          }
        }
        return callback(null, modelMap);
      }, function (modelMap, callback) {
        // save new models to db and return new tree branch
        async.each(Object.keys(modelMap), function (key, cb) {
          modelMap[key].save(req, cb);
        },
        function (err) {
          if (err) {
            return callback(err);
          }
          self.rebuildTree(req, function (err) {
            if (err) {
              return callback(err);
            }
            var top = modelMap[doc._id];
            self.getTree(req, top._id, callback);
          });
        });
      }], function (err, newSubTree) {
        if (err) {
          logging.error(req, 'Error in tree copy - ', err);
        }
        return fn(err, newSubTree);
      });
    },

    move: function move(req, doc, parentId, fn) {
      var self = this;

      if (!parentId) {
        return fn(new Error('no_id_provided'));
      }

      this.update(req, { _id: doc._id }, { parentId: parentId }, function (err, doc) {
        if (err) {
          return fn(err);
        }

        self.rebuildTree(req, function (err) {
          return fn(err, doc);
        });
      });
    },

    remove: function remove(req, id, fn) {
      var self = this;
      if (id && id._id) {
        id = id._id;
      }
      self.getSelfAndDescendants(req, id, function (err, docs) {
        if (err) {
          return fn(err);
        }

        var item = docs.filter(function (doc) {
          return $.utils.idEquals(doc, id);
        })[0];

        if (!item) {
          return fn(new Error('invalid_id_provided'));
        }

        var inUse = !!docs.filter(function (doc) {
          return doc.use_counter;
        }).length;

        if (inUse) {
          return fn(new Error('item_in_use'));
        }

        var ids = docs.map(function (doc) {
          return doc._id;
        });

        Base.prototype.remove.call(self, req, {
          _id: { $in: ids }
        }, function (err) {
          // if root node is removed, no need to rebuild tree
          if (err || !item.parentId) {
            return fn(err);
          }
          self.rebuildTree(req, fn);
        });
      });
    },

    getSelfAndDescendants: function getSelfAndDescendants(req, id, fn) {
      var self = this;
      var cacheKey = [this.CACHE_KEY].concat(req.organizationId || [], id || []).join('_');

      $.utils.cache.get(cacheKey, function (err, data) {
        // returned cached data if available
        if (data && data[cacheKey]) {
          return fn(null, data[cacheKey]);
        }

        self.findOne(req, {
          conditions: { _id: id },
          fields: self.defaultFields.concat(' rgt lft')
        }, function (err, doc) {
          if (err) {
            return fn(err);
          }
          if (!doc) {
            var modelName = self._model.modelName.split('.').pop();
            return fn(modelName.concat(' not found'));
          }
          var params = {
            conditions: { lft: { $gte: doc.lft }, rgt: { $lte: doc.rgt } }
          };

          self.find(req, params, function (err, docs) {
            $.utils.cache.set(cacheKey, docs, function () {
              return fn(err, docs);
            });
          });
        });
      });
    },

    getTree: function getTree(req, id, fn, fields) {
      var self = this;

      if (typeof id === 'function') {
        fields = fn;
        fn = id;
        id = undefined;
      }

      fields = fields || this.defaultFields;

      this.findOne(req, {
        // if an id is given, start from that item, else start from root
        conditions: id ? { _id: id } : { parentId: { $exists: false } },
        fields: fields.concat(' rgt lft')
      }, function (err, root) {
        if (err) {
          return fn(err);
        }

        if (!root) {
          return fn();
        }

        self.find(req, {
          conditions: { lft: { $gte: root.lft }, rgt: { $lte: root.rgt } },
          fields: fields
        }, function (err, docs) {
          var top = docs.filter(function (r) {
            return $.utils.idEquals(r, root);
          });
          if (!top.length) {
            return fn(new Error('root_node_not_found'));
          }
          return fn(err, self.buildTree(top[0], docs));
        });
      });
    },

    rebuildTree: function rebuildTree(req, fn) {
      var self = this;
      this.findOne(req, { conditions: { parentId: { $exists: false } } }, function (err, root) {
        if (err) {
          return fn(err);
        }
        self._model.rebuildTree(root, 1, fn);
      });
    }

  });

  return NestedSetService;

};
