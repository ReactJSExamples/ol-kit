![ol-kit logo](https://raw.github.com/MonsantoCo/ol-kit/master/config/jsdoc/template/static/readme-ol-kit-logo.png)

![npm version](https://img.shields.io/npm/v/@bayer/ol-kit)

An easy to use, open source [React](https://github.com/facebook/react) & [OpenLayers](https://github.com/openlayers/openlayers) map component toolkit.

## Installation
Install `ol-kit` and its `peerDependencies`

```
npm i @bayer/ol-kit ol@4.6.5 react react-dom styled-components --save
```

## Getting Started
It's easy to start building map apps with ol-kit. For simple projects the following will get you started:
```javascript
import React from 'react'
import { Map, Popup, Controls, zoomToExtent } from '@bayer/ol-kit'

import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'

class App extends React.Component {
  onMapInit = map => {
    const data = new VectorLayer({
      source: new VectorSource({
        features: [/** get some data and have fun with it */]
      })
    })

    // add the data to the map
    map.addLayer(data)

    // quickly take the map
    zoomToExtent([0, 0], 12)
  }

  render () {
    return (
      <Map onMapInit={this.onMapInit}>
        <Popup />
        <Controls />
      </Map>
    )
  }
```

## Documentation
The documentation for the project is available in the `/docs` directory and the hosted version is available at [ol-kit.com](https://ol-kit.com).

## Bugs & Feature Requests
If you find a bug or think of a new feature, please submit a Github issue.

## Maintainers & Contributions
The current maintainers are listed in [MAINTAINERS.md](https://github.com/MonsantoCo/ol-kit/blob/master/MAINTAINERS.md). If you would like contribute to the project see [CONTRIBUTING.md](https://github.com/MonsantoCo/ol-kit/blob/master/CONTRIBUTING.md).

## Sponsor
The ol-kit project was internally developed at Bayer Crop Science. Without the generous support of various stakeholders at Bayer, this project would never have become an open source reality. Thank you for the support, resources & final approval!

![ol-kit logo](https://raw.github.com/MonsantoCo/ol-kit/master/config/jsdoc/template/static/readme-bayer-logo.png)
