'use strict';

module.exports = function ($) {

  $.mongoose.NestedSetService = require('./lib/nested-set-service')($);
  $.mongoose.NestedSetPlugin = require('mongoose-nested-set');

};
