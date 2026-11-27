import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
	findShaderFillShapes,
	findImageFillShapes,
} from '../src/modules/imageBake.js'

// Two imageShader placement paths exist, and they must not overlap: a shape
// repeated by a duplicator in the same comp bakes a per-copy lattice, while a
// shape inside a referenced comp is drawn once and instanced per copy, so it
// needs one image of its own. Measured case: compNode#18 "a" holds
// basicShape#3 + imageShader#2, and duplicator#32 instances it through
// compositionReference#14.

// api.getParent returns "" across a composition reference in Cavalry 2.8.1, so
// no parent chain ever reaches the consuming duplicator. The comp-local path
// therefore must not depend on one.
function scene() {
	const types = {
		'compNode#25': 'compNode',
		'duplicator#32': 'duplicator',
		'compositionReference#14': 'compositionReference',
		'compNode#18': 'compNode',
		'basicShape#3': 'basicShape',
		'imageShader#2': 'imageShader',
		'textShape#59': 'textShape',
	}
	const children = {
		'compNode#25': ['duplicator#32', 'compositionReference#14'],
		'duplicator#32': [],
		'compositionReference#14': [],
		'compNode#18': ['basicShape#3', 'textShape#59'],
		'basicShape#3': ['imageShader#2'],
		'imageShader#2': [],
		'textShape#59': [],
	}
	const conn = {
		'compositionReference#14': { composition: 'compNode#18.id' },
		// The shape's colour slot is fed by the shader, so this is the connection
		// imageShaderOf reads.
		'basicShape#3': {
			'material.colorShaders.0.shader': 'imageShader#2.id',
		},
		'imageShader#2': { image: 'asset#2.id' },
	}
	const inAttrs = {
		'basicShape#3': ['material.colorShaders.0.shader', 'scale.y'],
	}
	return {
		getLayerType: (id) => types[id] || '',
		getChildren: (id) => children[id] || [],
		getParent: () => '',
		getInConnection: (id, attr) => (conn[id] && conn[id][attr]) || '',
		getInConnectedAttributes: (id) => inAttrs[id] || [],
	}
}

test('a shader inside a referenced comp is found by the comp-local path', () => {
	const prev = globalThis.api
	globalThis.api = scene()
	try {
		const hits = findShaderFillShapes('compNode#18')
		assert.equal(hits.length, 1)
		assert.equal(hits[0].shape, 'basicShape#3')
		assert.equal(hits[0].shader, 'imageShader#2')
		assert.equal(hits[0].slot, 'material.colorShaders.0.shader')
	} finally {
		globalThis.api = prev
	}
})

test('the comp-local path ignores a shape a duplicator in the same comp repeats', () => {
	// That shape has a lattice to bake per copy, so baking a single image here
	// would double up and lose the per-copy placement.
	const prev = globalThis.api
	const api = scene()
	api.getParent = (id) =>
		id === 'basicShape#3' ? 'duplicator#32' : 'compNode#18'
	globalThis.api = api
	try {
		assert.equal(findShaderFillShapes('compNode#18').length, 0)
	} finally {
		globalThis.api = prev
	}
})

test('the per-copy path finds nothing when the duplicator sits across a composition reference', () => {
	// The measured defect: basicShape#3 has no duplicator ancestor, so before the
	// comp-local path existed no image was ever baked for this scene.
	const prev = globalThis.api
	globalThis.api = scene()
	try {
		assert.deepEqual(findImageFillShapes('compNode#25'), [])
	} finally {
		globalThis.api = prev
	}
})

test('the comp-local path does not follow composition references', () => {
	// Each referenced comp is exported as its own asset, so the pass runs on that
	// comp and its shapes are local to it. Following the reference from the shell
	// would bake the same shader a second time.
	const prev = globalThis.api
	globalThis.api = scene()
	try {
		assert.equal(findShaderFillShapes('compNode#25').length, 0)
		assert.equal(findShaderFillShapes('compNode#18').length, 1)
	} finally {
		globalThis.api = prev
	}
})
