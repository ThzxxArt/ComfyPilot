/**
 * mediaTypes (0.1.14) — the single classification source of truth.
 *
 * Before 0.1.14 the same classification lived in four drifting copies
 * (p1p2.ts ×3 + media.ts MEDIA_EXT). These tests pin the shared catalogue's
 * behaviour so every consumer (scanner, indexer, protocol, renderer) agrees.
 */
import { describe, expect, it } from 'vitest'
import {
  AUDIO_EXT,
  IMAGE_RAW_EXT,
  IMAGE_WEB_EXT,
  MODEL3D_EXT,
  VIDEO_EXT,
  classifyOutputType,
  extOf,
  isMediaServable,
  isRawImage,
  isWebViewableImage
} from '../../src/shared/mediaTypes'

describe('extOf', () => {
  it('returns the lower-case extension including the dot', () => {
    expect(extOf('foo.PNG')).toBe('.png')
    expect(extOf('C:\\path\\to\\Foo.Mp4')).toBe('.mp4')
    expect(extOf('/posix/dir/bar.EXR')).toBe('.exr')
  })

  it('returns empty for no/false-positive extensions', () => {
    expect(extOf('noext')).toBe('')
    expect(extOf('')).toBe('')
    expect(extOf('trailing.')).toBe('')
    expect(extOf('.hidden')).toBe('')
    expect(extOf('name with spaces.')).toBe('')
    // "file.v 2" — the segment after the dot isn't a clean extension.
    expect(extOf('file.v 2')).toBe('')
  })

  it('only treats the final dot as the extension boundary', () => {
    expect(extOf('archive.tar.gz')).toBe('.gz')
    expect(extOf('a.b.c.glb')).toBe('.glb')
    expect(extOf('dir.with.dots/file')).toBe('')
  })
})

describe('classifyOutputType', () => {
  it('classifies web images as image', () => {
    for (const ext of IMAGE_WEB_EXT) {
      expect(classifyOutputType(`x${ext}`)).toBe('image')
    }
  })

  it('classifies raw images (exr/hdr/tiff) as image', () => {
    for (const ext of IMAGE_RAW_EXT) {
      expect(classifyOutputType(`x${ext}`)).toBe('image')
    }
    expect(classifyOutputType('OUTPUT.EXR')).toBe('image')
  })

  it('classifies video (mkv included — the old inline chains dropped it)', () => {
    for (const ext of VIDEO_EXT) {
      expect(classifyOutputType(`clip${ext}`)).toBe('video')
    }
    expect(classifyOutputType('movie.MKV')).toBe('video')
  })

  it('classifies audio', () => {
    for (const ext of AUDIO_EXT) {
      expect(classifyOutputType(`sound${ext}`)).toBe('audio')
    }
  })

  it('classifies 3D models', () => {
    for (const ext of MODEL3D_EXT) {
      expect(classifyOutputType(`mesh${ext}`)).toBe('3d')
    }
    expect(classifyOutputType('SCENE.GLB')).toBe('3d')
  })

  it('returns other for unknown or missing extensions', () => {
    expect(classifyOutputType('readme.txt')).toBe('other')
    expect(classifyOutputType('noext')).toBe('other')
    expect(classifyOutputType('.gltf.bin')).toBe('other')
    expect(classifyOutputType('')).toBe('other')
  })
})

describe('predicates', () => {
  it('isWebViewableImage excludes raw image formats', () => {
    expect(isWebViewableImage('a.png')).toBe(true)
    expect(isWebViewableImage('a.webp')).toBe(true)
    expect(isWebViewableImage('a.exr')).toBe(false)
    expect(isWebViewableImage('a.hdr')).toBe(false)
    expect(isWebViewableImage('a.tiff')).toBe(false)
  })

  it('isRawImage matches only the raw image family', () => {
    expect(isRawImage('render.exr')).toBe(true)
    expect(isRawImage('render.HDR')).toBe(true)
    expect(isRawImage('render.png')).toBe(false)
    expect(isRawImage('model.glb')).toBe(false)
  })

  it('isMediaServable covers web images + videos + audio, nothing else', () => {
    expect(isMediaServable('a.png')).toBe(true)
    expect(isMediaServable('a.mp4')).toBe(true)
    expect(isMediaServable('a.mkv')).toBe(true)
    expect(isMediaServable('a.mp3')).toBe(true)
    expect(isMediaServable('a.flac')).toBe(true)
    // Raw images and 3D open with the OS default app — never the protocol.
    expect(isMediaServable('a.exr')).toBe(false)
    expect(isMediaServable('a.hdr')).toBe(false)
    expect(isMediaServable('a.glb')).toBe(false)
    expect(isMediaServable('a.obj')).toBe(false)
    expect(isMediaServable('a.txt')).toBe(false)
  })

  it('servable extension families are disjoint from raw-image and 3D families', () => {
    for (const ext of [...IMAGE_RAW_EXT, ...MODEL3D_EXT]) {
      expect(isMediaServable(`x${ext}`)).toBe(false)
    }
    for (const ext of [...IMAGE_WEB_EXT, ...VIDEO_EXT, ...AUDIO_EXT]) {
      expect(isMediaServable(`x${ext}`)).toBe(true)
    }
  })
})
