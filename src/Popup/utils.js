import bboxTurf from '@turf/bbox'
import { lineString } from '@turf/helpers'
import centroid from '@turf/centroid'
import olMap from 'ol/map'
import olCircle from 'ol/geom/circle'
import olPolygon from 'ol/geom/polygon'
import olObservable from 'ol/observable'
import olSourceImageWMS from 'ol/source/imagewms'
import olSourceTileWMS from 'ol/source/tilewms'
import GeoJSON from 'ol/format/geojson'
import proj from 'ol/proj'
import debounce from 'lodash.debounce'

import { buildWfsFilters } from 'utils/geoserver'
import ugh from 'ugh'

const VMF_RESERVED = {
  filters: '_vmf_filters',
  basemap: '_vmf_basemap',
  catalogId: '_vmf_catalogId'
}

/**
 * Bind multiple move listeners with the same callback
 * @function
 * @since 0.1.0
 * @param {ol.Map} map - The openlayers map to which the events are bound
 * @param {Function} callback - The callback invoked when a `change:size`, `change:resolution` or a `change:center` event was fired
 * @param {Object} [thisObj] - The object to use as `this` in the event listeners.
 * @returns {ol.EventsKey[]} Array of openlayers event keys for unsetting listener events (use with removeMovementListener)
 */
export const addMovementListener = (map, callback, thisObj) => {
  if (typeof callback !== 'function') return ugh.error('addMovementListener requires a valid openlayers map & callback function') // eslint-disable-line

  // If performance becomes an issue with catalog layers & far zoom level, these debounce levels can be adjusted
  const slowDebounce = debounce(callback, 0)
  const fastDebounce = debounce(callback, 0)

  const keys = [
    map.on('change:size', slowDebounce, thisObj),
    map.getView().on('change:resolution', slowDebounce, thisObj),
    map.getView().on('change:center', fastDebounce, thisObj)
  ]

  return keys
}

/**
 * Remove list of event keys
 * @function
 * @since 0.1.0
 * @param {ol.Map} map - The openlayers map to which the events are bound
 * @param {Array} keys - remove the listeners via an array of event keys
 */
export const removeMovementListener = (keys = []) => {
  keys.forEach(key => olObservable.unByKey(key))
}

/**
 * Make a WMS layer retrieve it's WFS features at a given pixel location
 * @function
 * @since 0.1.0
 * @param {Object} event - An object with an `event` and `pixel` property
 * @param {ol.Map} event.map - The openlayers map where the layer exists
 * @param {Number[]} event.pixel - An array consisting of `x` and `y` pixel locations
 * @returns {ol.Source} The openlayers source where the features were just added
 */
export const convertWmsToWfsAndAddToMap = (event, catalogLayer, opts = {}) => {
  const { map, pixel } = event
  const source = catalogLayer.getWfsSource()
  const coords = map.getCoordinateFromPixel(pixel)
  const existingFilters = catalogLayer.get(VMF_RESERVED.filters) || ['AND', new Map()]
  const properties = source.getProperties().body
  const geometryName = properties.geometryName
  const bufferSize = opts.hitTolerance ? opts.hitTolerance : 8
  // calculate hitTolerance in units relative to map view resoultion
  const relativeUnits = bufferSize * map.getView().getResolution()
  // apply hitTolerance as radius of circle
  const bufferedClick = olPolygon.fromCircle(new olCircle(coords, relativeUnits))
  const intersectParams = new Set([[geometryName, bufferedClick, 'EPSG:3857']])

  existingFilters[1].set('INTERSECTS', intersectParams)
  const filter = {
    filter: buildWfsFilters(existingFilters),
    maxFeatures: 50,
    outputFormat: undefined
  }
  const body = Object.assign(properties, filter)

  source.clear()
  source.setFilter && source.setFilter(body)
  source.refresh()

  return source
}

/**
 * Get all features for a given click event
 * @function
 * @since 0.1.0
 * @param {Object} event - An object with an `event` and `pixel` property
 * @param {ol.Map} event.map - The openlayers map where the layer exists
 * @param {Number[]} event.pixel - An array consisting of `x` and `y` pixel locations
 * @param {Object} [opts] - Object of optional params
 * @param {Number} [opts.hitTolerance = 3] - Additional area around features that is clickable to select them
 * @returns {Promise[]} An array of promises, each of which resolve to an object `{ layer, features }`
 */
export const getLayersAndFeaturesForEvent = (event, opts = {}) => {
  if (typeof event !== 'object') return ugh.error('getLayersAndFeaturesForEvent first arg must be an object') // eslint-disable-line
  const { map, pixel } = event
  const promises = []

  if (!(map instanceof olMap) || !Array.isArray(pixel)) return ugh.error('getLayersAndFeaturesForEvent requires a valid openlayers map & pixel location (as an array)') // eslint-disable-line

  const wfsSelector = layer => {
    const source = layer.getSource && layer.getSource()
    const isWMS = source instanceof olSourceImageWMS || source instanceof olSourceTileWMS
    const isGeoServerlayer = layer.isGeoserverLayer

    if (!layer.get(VMF_RESERVED.catalogId) && layer.getLayerState().managed && !layer.get(VMF_RESERVED.basemap) && !isWMS && !isGeoServerlayer) { // eslint-disable-line
      // catalog layers are handled by wmsSelector
      // layer.getLayerState().managed is an undocumented ol prop that lets us ignore select's vector layer
      // _vmf_basemap is set to true on all basemaps via vmf
      const features = []
      const sourceFeatures = layer.getSource().getFeatures()

      sourceFeatures.forEach(sourceFeature => {
        // check if any feature on layer source is also at click location
        const isAtPixel = featuresAtPixel ? featuresAtPixel.find(f => f === sourceFeature) : null

        if (isAtPixel) features.push(sourceFeature)
      })
      const wfsPromise = Promise.resolve({ features, layer })

      if (features.length) promises.push(wfsPromise)
    }
  }
  const wmsSelector = layer => {
    const source = layer.getSource && layer.getSource()
    const isWMS = source instanceof olSourceImageWMS || source instanceof olSourceTileWMS

    if (!!layer.get(VMF_RESERVED.catalogId) && isWMS) {
      // if we're dealing with a catalog layer, only work with the WFS source
      // ignore wms layers that are not catalog layers
      const catalogLayers = map.getLayers(true).getArray().filter(layer => layer.isCatalogLayer)
      const catalogLayer = catalogLayers.find(cat => cat.layers.get('wms').get('_vmf_catalogId') === layer.get('_vmf_catalogId'))
      const wfsSource = convertWmsToWfsAndAddToMap(event, catalogLayer, opts)
      const wmsPromise = new Promise(resolve => {
        const features = []
        const featureCounter = e => {
          // clear the timeout to resolve an empty array if features exist
          clearTimeout(timeout)
          features.push(e.feature)
          resolver()
        }
        const resolver = debounce(() => {
          resolve({ features, layer })
        }, 200)

        wfsSource.on('addfeature', featureCounter)
        // in the case no features get converted/added to source resolve empty array
        const timeout = setTimeout(() => resolve({ features: [], layer }), 1000)
      })

      promises.push(wmsPromise)
    } else if (!!layer.get('_ol_kit_parent') && layer.get('_ol_kit_parent').isGeoserverLayer) {
      // this logic handles clicks on GeoserverLayers
      const parentLayer = layer.get('_ol_kit_parent')
      const coords = map.getCoordinateFromPixel(pixel)
      const wmsPromise = new Promise(async resolve => {
        const rawFeatures = await parentLayer.fetchFeaturesAtClick(coords, map)
        // filter out deleted=true from PFO layers
        const features = rawFeatures.filter(feature => feature.get('deleted') != 'true') // eslint-disable-line eqeqeq

        resolve({ features, layer })
      })

      promises.push(wmsPromise)
    }
  }
  // check for featuresAtPixel to account for hitTolerance first then do catalogLayer check as well
  const featuresAtPixel = map.getFeaturesAtPixel(pixel, {
    hitTolerance: opts.hitTolerance ? opts.hitTolerance : 3
  })

  // if there's features at click, loop through the layers to find corresponding layer & features
  if (featuresAtPixel) map.getLayers().getArray().forEach(wfsSelector)

  // this check is for wms features on catalog layers
  map.forEachLayerAtPixel(pixel, wmsSelector)

  return promises
}

/**
 * Get the best position for the popup to be displayed given features
 * @function
 * @param {Object} event - An object with an `event` and `pixel` property
 * @param {ol.Map} event.map - The openlayers map where the layer exists
 * @param {Number[]} event.pixel - An array consisting of `x` and `y` pixel locations
 * @param {ol.Feature[]} features - An array of features around which the popup should position
 * @param {Object} [opts]
 * @param {Number} [opts.popupHeight = 280] - The height of the popup
 * @param {Number} [opts.popupWidth = 280] - The width of the popup
 * @param {Number} [opts.arrowHeight = 16] - The height of the popup's arrow/pointer
 * @param {Number} [opts.navbarOffset = 55] - The height of the navbar
 * @param {Number[]} [opts.viewPadding = [0, 0, 0, 0]] - An array of padding to apply to the best fit logic in top, right, bottom, left order
 * @returns {Object} An object containing the arrow/pointer position, pixel location & if the popup will fit properly within the viewport
 */
export const getPopupPositionFromFeatures = (event, features, opts = {}) => {
  if (typeof event !== 'object' || !Array.isArray(features)) return ugh.error('getPopupPositionFromFeatures first arg must be an object & second arg array of features')
  const { map, pixel = [0, 0] } = event

  if (!(map instanceof olMap)) return ugh.error('getPopupPositionFromFeatures requires a valid openlayers map as a property of the first arg')
  const arrowHeight = opts.arrowHeight || 16
  const geoJSON = new GeoJSON({ dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' })
  const height = opts.popupHeight || 280
  const width = opts.popupWidth || 280
  const fullHeight = height + arrowHeight
  const fullWidth = width + arrowHeight
  const [mapX, mapY] = map.getSize()

  const getPadding = (idx) => opts.viewPadding ? opts.viewPadding[idx] : calculateViewPadding(map)[idx]
  const padding = {
    top: getPadding(0),
    right: getPadding(1),
    bottom: getPadding(2),
    left: getPadding(3)
  }
  // olMap.getPixelFromCoordinate return s a pixel relative to the map's target element so we need to convert that to a pixel relative to the window.
  const mapToScreenPixel = (pixel = [0, 0]) => {
    const { x, y } = map.getTargetElement().getBoundingClientRect()
    const offset = [x, y]

    return pixel.map((val, i) => {
      return val + offset[i]
    })
  }

  // find bbox for passed features
  const getFitsForFeatures = rawFeatures => {
    // create a new array so original features are not mutated when _ol_kit_parent is nullified
    const features = rawFeatures.map(feature => {
      const clone = feature.clone()

      // this removes a ref to _ol_kit_parent to solve circularJSON bug
      clone.set('_ol_kit_parent', null)

      return clone
    })
    const jsonFeatures = geoJSON.writeFeatures(features)
    const [minX, minY, maxX, maxY] = bboxTurf(JSON.parse(jsonFeatures))

    return {
      top: getMidPixel([[minX, maxY], [maxX, maxY]]),
      right: getMidPixel([[maxX, maxY], [maxX, minY]]),
      bottom: getMidPixel([[minX, minY], [maxX, minY]]),
      left: getMidPixel([[minX, minY], [minX, maxY]])
    }
  }

  const getMidPixel = lineCoords => {
    const centerFeature = centroid(lineString(lineCoords))
    const coords = geoJSON.readFeature(centerFeature).getGeometry().flatCoordinates

    return map.getPixelFromCoordinate(coords)
  }

  const fitsRight = ([x, y]) => x + fullWidth <= mapX - padding.right && y >= (height / 2) + padding.top && y + (height / 2) <= mapY - padding.bottom // eslint-disable-line
  const fitsBelow = ([x, y]) => y + fullHeight - padding.bottom <= mapY && (width / 2) + padding.left <= x && x + (width / 2) - padding.right <= mapX // eslint-disable-line
  const fitsAbove = ([x, y]) => y - padding.top >= fullHeight && (width / 2) + padding.left <= x && x + (width / 2) - padding.right <= mapX // eslint-disable-line
  const fitsLeft = ([x, y]) => x + padding.left >= fullWidth && y >= (height / 2) + padding.top && y + (height / 2) <= mapY - padding.bottom // eslint-disable-line

  // the order of these checks determine which side is tried first (right, left, top, and then bottom)
  const getPosition = bbox => {
    if (fitsRight(bbox.right)) return { arrow: 'left', pixel: mapToScreenPixel(bbox.right), fits: true }
    if (fitsLeft(bbox.left)) return { arrow: 'right', pixel: mapToScreenPixel(bbox.left), fits: true }
    if (fitsAbove(bbox.top)) return { arrow: 'bottom', pixel: mapToScreenPixel(bbox.top), fits: true }
    if (fitsBelow(bbox.bottom)) return { arrow: 'top', pixel: mapToScreenPixel(bbox.bottom), fits: true }

    if (opts.lastPosition) {
      if (opts.lastPosition.arrow === 'left') return { arrow: 'left', pixel: mapToScreenPixel(bbox.right), fits: false }
      if (opts.lastPosition.arrow === 'top') return { arrow: 'top', pixel: mapToScreenPixel(bbox.bottom), fits: false }
      if (opts.lastPosition.arrow === 'bottom') return { arrow: 'bottom', pixel: mapToScreenPixel(bbox.top), fits: false }
      if (opts.lastPosition.arrow === 'right') return { arrow: 'right', pixel: mapToScreenPixel(bbox.left), fits: false }
      if (opts.lastPosition.arrow === 'none') return { arrow: 'none', pixel: mapToScreenPixel(opts.lastPosition.pixel), fits: false }
    }

    // if none of the above return, it doesn't fit on any side (it's on top of or within)
    return { arrow: 'none', pixel: mapToScreenPixel(pixel), fits: false }
  }

  return getPosition(getFitsForFeatures(features))
}

/**
 * Calculate bounding box of elements on page with _popup_boundary class and returns padding array excluding area of these elements
 * @function
 * @param {olMap} map - An instance of an openlayers map
 * @param {Object} opts
 * @returns {Array} - Array of view padding pixel numbers: [top, right, bottom, left]
 */
export const calculateViewPadding = (map, opts = {}) => {
  if (!(map instanceof olMap)) return ugh.error('calculateViewPadding requires a valid openlayers map as arg')
  const viewPadding = [0, 0, 0, 0]
  const navbarOffset = opts.navbarOffset || 55
  const boundaryElements = Array.from(document.getElementsByClassName('_popup_boundary'))
  const [mapX, mapY] = map.getSize()

  boundaryElements.forEach(elem => {
    const bbox = elem.getBoundingClientRect()
    const isOffScreen = bbox.x < 0 || bbox.x >= mapX || bbox.y < navbarOffset || bbox.y >= mapY

    if (!isOffScreen) {
      if (bbox.right < mapX / 2) {
        // set left padding for elements on left half of map
        const newPadding = bbox.right

        if (viewPadding[3] < newPadding) viewPadding[3] = newPadding
      } else if (bbox.left > mapX / 2) {
        // set right padding for elements on right half of map
        const newPadding = mapX - bbox.left

        if (viewPadding[1] < newPadding) viewPadding[1] = newPadding
      } else if (bbox.top > mapY / 2) {
        // set bottom padding for elements on bottom half of map
        const newPadding = (mapY + navbarOffset) - bbox.top

        if (viewPadding[2] < newPadding) viewPadding[2] = newPadding
      } else if (bbox.y > navbarOffset) {
        // set top padding for elements lower than navbar
        const newPadding = bbox.bottom

        if (viewPadding[0] < newPadding) viewPadding[0] = newPadding
      }
    }
  })

  return viewPadding
}