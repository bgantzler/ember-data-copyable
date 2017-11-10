import Ember from 'ember';
import getTransform from 'ember-data-copyable/utils/get-transform';
import isUndefined from 'ember-data-copyable/utils/is-undefined';
import { COPY_TASK, COPY_TASK_RUNNER, IS_COPYABLE } from 'ember-data-copyable/-private/symbols';
import { task, all } from 'ember-concurrency';

const {
  assign,
  Logger,
  guidFor,
  isEmpty,
  runInDebug,
  Copyable,
  setProperties
} = Ember;

const {
  keys
} = Object;

const PRIMITIVE_TYPES = ['string', 'number', 'boolean'];

const DEFAULT_OPTIONS = {
  // List of all attributes to ignore
  ignoreAttributes: [],

  // List of other attributes to copy
  otherAttributes: [],

  // List of all attributes to copy by reference
  copyByReference: [],

  // Overwrite specific keys with a given value
  overwrite: {},

  // Relationship options
  relationships: {},

  // Create models in the store, or use objectDefinition
  createAsModel: true,

  // Object to create if not a model
  objectDefinition: null
};

export default Ember.Mixin.create({
  /**
   * Copyable options for the specific model. See DEFAULT_OPTIONS for details
   *
   * @type {Object}
   * @public
   */
  copyableOptions: null,

  /**
   * @type {Boolean}
   * @private
   */
  [IS_COPYABLE]: true,

  /**
   * Entry point for copying the model
   *
   * @method copy
   * @public
   * @async
   * @param  {Boolean} deep If `true`, a deep copy of the model will be made
   * @param  {Object} options Options for the copy which will override model
   *                          specified options. See DEFAULT_OPTIONS.
   * @return {TaskInstance} A promise like TaskInstance
   */
  copy(/* deep, options */) {
    return this.get(COPY_TASK_RUNNER).perform(...arguments);
  },

  /**
   * The copy task runner. Allows our copy task to have a drop
   * concurrency policy
   *
   * @type {Task}
   * @private
   */
  [COPY_TASK_RUNNER]: task(function *(deep, options) {
    let _meta = { copies: {}, transforms: {} };
    let store = this.get('store');
    let isSuccessful = false;

    try {
      let model = yield this.get(COPY_TASK).perform(deep, options, _meta);
      isSuccessful = true;

      return model;
    } catch (e) {
      runInDebug(() => Logger.error('[ember-data-copyable]', e));

      // Throw so the task promise will be rejected
      throw new Error(e);
    } finally {
      if (!isSuccessful) {
        let copiesKeys = keys(_meta.copies);

        // Display the error
        runInDebug(() => Logger.error(`[ember-data-copyable] Failed to copy model '${this}'. Cleaning up ${copiesKeys.length} created copies...`));

        // Unload all created records
        copiesKeys.forEach((key) => store.unloadRecord(_meta.copies[key]));
      }
    }
  }).drop(),

  /**
   * The copy task that gets called from `copy`. Does all the grunt work.
   *
   * NOTE: This task cannot have a concurrency policy since it breaks cyclical
   *       relationships.
   *
   * @type {Task}
   * @private
   */
  [COPY_TASK]: task(function *(deep, _options, _meta) {
    let options = assign({}, DEFAULT_OPTIONS, this.get('copyableOptions'), _options);

    let { ignoreAttributes, otherAttributes, copyByReference, overwrite } = options;
    let { copies } = _meta;
    let { modelName } = this.constructor;
    let store = this.get('store');
    let guid = guidFor(this);
    let relationships = [];
    let dAttrs = {}, rAttrs = {};

    // Handle cyclic relationships: If the model has already been copied,
    // just return that model
    if (copies[guid]) {
      return copies[guid];
    }

    let model = null;
    if (options.createAsModel) {
      model = store.createRecord(modelName);
    } else {
      if (options.objectDefinition) {
        model = options.objectDefinition.create({})
      } else {
        model = {};
      }
    }

    copies[guid] = model;

    // Copy all the attributes
    this.eachAttribute((name, { type, options: attributeOptions }) => {
      if (ignoreAttributes.includes(name)) {
        return;
      } else if (!isUndefined(overwrite[name])) {
        dAttrs[name] = overwrite[name];
      } else if (
          !isEmpty(type) &&
          !copyByReference.includes(name) &&
          !PRIMITIVE_TYPES.includes(type)
      ) {
        let value = this.get(name);

        if (Copyable && Copyable.detect(value)) {
          // "value" is an Ember.Object using the Ember.Copyable API (if you use
          // the "Ember Data Model Fragments" addon and "value" is a fragment or
          // if use your own serializer where you deserialize a value to an
          // Ember.Object using this Ember.Copyable API)
          value = value.copy(deep);
        } else {
          let transform = getTransform(this, type, _meta);

          // Run the transform on the value. This should guarantee that we get
          // a new instance.
          value = transform.serialize(value, attributeOptions);
          value = transform.deserialize(value, attributeOptions);
        }

        dAttrs[name] = value;
      } else {
        dAttrs[name] = this.get(name);
      }
    });

    // Get all the relationship data
    this.eachRelationship((name, meta) => {
      if (!ignoreAttributes.includes(name)) {
        relationships.push({ name, meta });
      }
    });

    // Copy all the relationships
    for (let i = 0; i < relationships.length; i++) {
      let { name, meta } = relationships[i];

      if (!isUndefined(overwrite[name])) {
        rAttrs[name] = overwrite[name];
        continue;
      }

      // We dont need to yield for a value if it's just copied by ref
      // or if we are doing a shallow copy
      if (!deep || copyByReference.includes(name)) {
        try {
          let ref = this[meta.kind](name);
          let copyRef = model[meta.kind](name);

          /*
            NOTE: This is currently private API but has been approved @igorT.
                  Supports Ember Data 2.5+
            */
          if (meta.kind === 'hasMany') {
            copyRef.hasManyRelationship.addRecords(ref.hasManyRelationship.members);
          } else if (meta.kind === 'belongsTo') {
            copyRef.belongsToRelationship.addRecords(ref.belongsToRelationship.members);
          }
        } catch (e) {
          rAttrs[name] = this.get(name);
        }

        continue;
      }

      let value = yield this.get(name);
      let relOptions = options.relationships[name];
      let deepRel = relOptions && typeof relOptions.deep === 'boolean' ? relOptions.deep : deep;

      if (meta.kind === 'belongsTo') {
        if (value && value.get(IS_COPYABLE)) {
          rAttrs[name] = yield value.get(COPY_TASK).perform(deepRel, relOptions, _meta);
        } else {
          rAttrs[name] = value;
        }
      } else if (meta.kind === 'hasMany') {
        let firstObject = value.get('firstObject');

        if (firstObject && firstObject.get(IS_COPYABLE)) {
          rAttrs[name] = yield all(
            value.getEach(COPY_TASK).invoke('perform', deepRel, relOptions, _meta)
          );
        } else {
          rAttrs[name] = value;
        }
      }
    }

    // Build the final attrs pojo by merging otherAttributes, the copied
    // attributes, and ant overwrites specified.
    let attrs = assign(this.getProperties(otherAttributes), dAttrs, rAttrs, overwrite);
    if (_options) {
      _options.dAttrs = dAttrs;
      _options.rAttrs = rAttrs;
      _options.attrs = attrs;
    }

    // Set the properties on the model
    setProperties(model, attrs);

    return model;
  })
});
