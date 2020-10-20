let https = require('https')

function fail(context, message) {
  context.done(null, {
    status: 500,
    body: message
  })
}

function dot(v1, v2) {
  return v1[0]*v2[0]+v1[1]*v2[1]
}

module.exports = function(context, req) {
  let origin         = req.query.origin         || (req.body && req.body.origin)
  let destination    = req.query.destination    || (req.body && req.body.destination)
  let departAt       = req.query.departAt       || (req.body && req.body.departAt)
  let includeAlts    = req.query.includeAlts    || (req.body && req.body.includeAlts)
  let azureMapsKey   = req.query.azureMapsKey   || (req.body && req.body.azureMapsKey)
  let forecastAPIKey = req.query.forecastAPIKey || (req.body && req.body.forecastAPIKey)

  let nowSec = Math.round((new Date).getTime() / 1000)
  let departAtSec = parseInt(departAt)

  let departAtChunk = ""
  if( departAtSec > (120+nowSec) )
    departAtChunk = "&departAt=" + (new Date(1000*departAtSec)).toISOString()

  let alternativesChunk = ""
  if( includeAlts == "true" )
    alternativesChunk = "&maxAlternatives=2"

  context.log(`RouteForecast request: origin=${origin} destination=${destination} departAt=${departAt} includeAlts=${includeAlts}`)

  let azureMapsPath = "/route/directions/json?api-version=1.0&query=" + origin + ":" + destination +
      departAtChunk + alternativesChunk + "&subscription-key=" + azureMapsKey

  let requestOptions = {
    host: "atlas.microsoft.com",
    path: azureMapsPath
  }

  let timeMapStart = new Date
  let azureMapsRequest = https.get(requestOptions, (resp) => {
    let azureMapsAPIBody = ""
    resp.on("data", (chunk) => { azureMapsAPIBody += chunk })
    resp.on("end", () => {
      let mapTimeMs = new Date - timeMapStart
      let azureMapsResponse = JSON.parse(azureMapsAPIBody)
      if( !azureMapsResponse.routes ) {
        fail(context, "No route found.")
        return
      }
      let routes = azureMapsResponse.routes
      let routeCount = routes.length
      let routePoints = []
      // Sample route data down to one point per minute.
      for( let i=0; i<routeCount; i++ ) {
        let route = routes[i]
        let timeSec = route.summary.travelTimeInSeconds
        let points = route.legs[0].points
        let pointCount = points.length
        let lastSeenMinute = 0
        let pointData = []
        for( let i=0; i<pointCount-1; i++ ) {
          let t = Math.round(timeSec * (i/pointCount))
          if( t >= lastSeenMinute ) {
            pointData.push({lat: points[i].latitude,
                            lng: points[i].longitude,
                            "relative-seconds": t})
            lastSeenMinute += 60
          }
        }
        pointData.push({lat: points[pointCount-1].latitude,
                        lng: points[pointCount-1].longitude,
                        "relative-seconds": timeSec})
        routePoints.push(pointData)
      }

      // Capture some route metadata, so the individual routes can be reconstructed
      let routeMetas = []
      for( let i=0; i<routeCount; i++ ) {
        let pointOffset = 0
        if( i>0 ) pointOffset = routeMetas[i-1].pointOffset + routeMetas[i-1].pointCount
        routeMetas.push({pointOffset: pointOffset, pointCount: routePoints[i].length})
      }

      let allPoints = [].concat.apply([], routePoints)
      let data = JSON.stringify({variables: [{"name":"Temperature","level":"Surface"},
                                             {"name":"RoadTemperature","level":"Surface"},
                                             {"name":"RoadState","level":"Surface"},
                                             {"name":"RouteDelayRisk","level":"Surface"},
                                             {"name":"PrecipitationRate","level":"Surface"},
                                             {"name":"PrecipitationRateMillisHr","level":"Surface"},
                                             {"name":"SnowDepth", "level":"Surface"},
                                             {"name":"WindSpeed","level":"10Meters"},
                                             {"name":"WindDirection","level":"10Meters"}],
                                 points: allPoints})

      let options = {
        hostname: "fathym-forecast-int.azure-api.net",
        path: "/api/v0/point-query",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
          "Ocp-Apim-Subscription-Key": forecastAPIKey
        }
      }

      let timeForecastStart = new Date
      let forecastAPIRequest = https.request(options, (res) => {
        let forecastAPIBody = ""
        res.on("data", (chunk) => { forecastAPIBody += chunk })
        res.on("end", () => {
          let forecastTimeMs = new Date - timeForecastStart

          let allOutPoints = []
          for( let i=0; i<allPoints.length; i++) {
            allOutPoints[i] = {
              lat: allPoints[i].lat,
              lng: allPoints[i].lng,
              "absoluteSeconds": allPoints[i]["relative-seconds"] + nowSec
            }
          }

          let forecastResponse = JSON.parse(forecastAPIBody)
          let outRoutes = []
          for( let i=0; i<routeCount; i++ ) {
            let outRoute = {}
            let start = routeMetas[i].pointOffset
            let end = start + routeMetas[i].pointCount
            outRoute.points = allOutPoints.slice(start, end)
            outRoute.forecast = {surfaceTemperature:        forecastResponse[0].values.slice(start, end),
                                 roadTemperature:           forecastResponse[1].values.slice(start, end),
                                 roadState:                 forecastResponse[2].values.slice(start, end),
                                 routeDelayRisk:            forecastResponse[3].values.slice(start, end),
                                 precipitationRate:         forecastResponse[4].values.slice(start, end),
                                 precipitationRateMillisHr: forecastResponse[5].values.slice(start, end),
                                 snowDepth:                 forecastResponse[6].values.slice(start, end),
                                 windSpeed:                 forecastResponse[7].values.slice(start, end),
                                 windDirection:             forecastResponse[8].values.slice(start, end)}
            let crosswindRisk = []
            for( let i=0; i<outRoute.points.length-1; i++ ) {
              let travelDirection = [outRoute.points[i+1].lng - outRoute.points[i].lng,
                                     outRoute.points[i+1].lat - outRoute.points[i].lat]
              let windDirRadians = outRoute.forecast.windDirection[i]*0.0174533
              let windDirection = [Math.sin(windDirRadians),Math.cos(windDirRadians)]
              let crosswind = Math.abs(dot(travelDirection, windDirection))
              let normalizedWindSpeed = Math.min(outRoute.forecast.windSpeed[i], 20) / 10.0
              crosswindRisk[i] = (1-crosswind)*normalizedWindSpeed
            }
            crosswindRisk.push(crosswindRisk[crosswindRisk.length-1])
            outRoute.forecast.crosswindRisk = crosswindRisk

            outRoutes.push(outRoute)
          }
          let outData = {routes: outRoutes}

          // TEMP: Backwards compatible shape:
          outData.points = outRoutes[0].points
          outData.forecast = outRoutes[0].forecast

          context.log(`RouteForecast complete: route-count=${routeCount} point-count=${allOutPoints.length} mapTimeMs=${mapTimeMs} forecastTimeMs=${forecastTimeMs}`)

          // Final, successful, return
          context.done(null, {body: JSON.stringify(outData),
                              headers: {"Content-Type": "application/json",
                                        "Access-Control-Allow-Origin": "*"}})
        })
      })
      forecastAPIRequest.on("error", (error) => {
        console.error(error)
      })
      forecastAPIRequest.write(data)
      forecastAPIRequest.end()
    })
  }).on("error", (error) => {
    fail(context, error)
  })
  azureMapsRequest.end()
}
