const Queue = require('tinyqueue')
const H = require('highland')
const { Client } = require('pg')

const client = new Client({
  user: 'docker',
  password: 'docker',
  host: 'localhost',
  database: 'gis',
  port: 35432
})

const table = 'osm_buildings'
// const table = 'osm_roads'

const xRange = [160, 195].map((c) => c * 1000) // RD, in meters
const yRange = [440, 490].map((c) => c * 1000)

// const xRange = [-7, 300].map((c) => c * 1000) // RD, in meters
// const yRange = [289, 629].map((c) => c * 1000)

// const outputFormat = 'geojson'
// length of base, in meters
// const initialCellSize = 4096
// const minCellSize = 64
// const maxCellSizeWithoutFeatures = 512

const outputFormat = 'csv' // or 'geojson'
const skipInvalid = false

const initialCellSize = 25
const minCellSize = 500
const maxCellSizeWithoutFeatures = 25

const transactionSize = 1000

function makeQuery (cell) {
  const center = `ST_Transform(ST_GeomFromText('POINT (${cell.cx} ${cell.cy})', 28992), 4326)`
  const cellDiagonal = `LINESTRING(${cell.x1} ${cell.y1}, ${cell.x2} ${cell.y2})`
  const envelope = `ST_Envelope(ST_Transform(ST_GeomFromText('${cellDiagonal}', 28992), 4326))`

  const query = `
    SELECT
      ST_AsGeoJSON(${center}, 6) AS point,
      round(ST_Distance(geography(geometry), geography(${center}))) AS distance,

      EXISTS (
        SELECT id FROM osm_admin
        WHERE ST_Intersects(${center}, geometry)
        LIMIT 1
      ) AND NOT
      EXISTS (
        SELECT id FROM osm_waterareas
        WHERE ST_Contains(geometry, ${center})
        LIMIT 1
      ) AND
      EXISTS (
        SELECT * FROM coastline
        WHERE ST_Intersects(geometry, ${center})
        LIMIT 1
      )
      AS center_valid,

      EXISTS (
        SELECT id FROM osm_admin
        WHERE ST_Intersects(${envelope}, geometry)
        LIMIT 1
      ) AND NOT
      EXISTS (
        SELECT id FROM osm_waterareas
        WHERE ST_Contains(geometry, ${envelope})
        LIMIT 1
      ) AND
      EXISTS (
        SELECT * FROM coastline
        WHERE ST_Intersects(geometry, ${envelope})
        LIMIT 1
      )
      AS envelope_valid

    FROM ${table}
    ORDER BY geometry <-> ${center}
    LIMIT 1
  ;`

  return query
}

async function run () {
  await client.connect()

  const output = H()

  if (outputFormat === 'geojson') {
    H([
      H(['{"type":"FeatureCollection","features":[\n']),
      output.intersperse(',\n'),
      H(['\n]}\n'])
    ]).sequence()
      .pipe(process.stdout)
  } else {
    H([
      H(['lat,lon,distance,valid\n']),
      output.intersperse('\n')
    ]).sequence()
      .pipe(process.stdout)
  }

  const cellQueue = new Queue([], compareCell)

  // cover polygon with initial cells
  for (let x = xRange[0]; x < xRange[1]; x += initialCellSize) {
    for (let y = yRange[0]; y < yRange[1]; y += initialCellSize) {
      cellQueue.push(new Cell(x, y, x + initialCellSize, y + initialCellSize))
    }
  }

  while (cellQueue.length) {
    const cells = []
    while (cellQueue.length && cells.length < transactionSize) {
      cells.push(cellQueue.pop())
    }

    const queries = cells.map(makeQuery)
    let results = []

    try {
      results = await client.query(queries.join('\n'))
    } catch (error) {
      console.error(error)
    }

    const validCells = results
      .map((result) => result.rows[0])
      .map((row, index) => ({
        row,
        cell: cells[index]
      }))
      .filter((result) => result.row.envelope_valid)
      .forEach((result) => {
        const cell = result.cell
        const row = result.row

        const valid = result.row.center_valid

        if (!skipInvalid || result.row.center_valid) {
          if (outputFormat === 'geojson') {
            const feature = {
              type: 'Feature',
              properties: {
                distance: row.distance,
                valid
              },
              geometry: JSON.parse(row.point)
            }
            output.write(JSON.stringify(feature))
          } else {
            const point = JSON.parse(row.point)
            const outputRow = [
              point.coordinates[1],
              point.coordinates[0],
              row.distance,
              valid
            ]
            output.write(outputRow.join(','))
          }
        }

        const doSubdivide = cell.size > maxCellSizeWithoutFeatures || row.distance > cell.size
        const tooSmall = cell.size < minCellSize

        if (result.row.envelope_valid && doSubdivide && !tooSmall) {
          cellQueue.push(new Cell(cell.x1, cell.y1, cell.cx, cell.cy))
          cellQueue.push(new Cell(cell.cx, cell.y1, cell.x2, cell.cy))
          cellQueue.push(new Cell(cell.x1, cell.cy, cell.cx, cell.y2))
          cellQueue.push(new Cell(cell.cx, cell.cy, cell.x2, cell.y2))
        }
      })
  }

  output.end()
  await client.end()
}

function Cell (x1, y1, x2, y2) {
  this.x1 = x1
  this.y1 = y1

  this.x2 = x2
  this.y2 = y2

  // cell center
  this.cx = (x2 - x1) / 2 + x1
  this.cy = (y2 - y1) / 2 + y1

  this.size = Math.abs(x2 - x1)
  this.area = Math.abs(x2 - x1) * Math.abs(y2 - y1)
}

function compareCell (a, b) {

  // https://gis.stackexchange.com/questions/101989/import-xyz-data-from-csv-into-gdal
  // If you have at least GDAL 1.11, you can open CSV files with the XYZ driver.
  // The file must conform to the rules described, such as increasing X values,
  // or the names used for the columns. In lieu of what your file looks like, here's a working example:

  return a.cx < b.cx && a.cy < b.cy

  return b.size - a.size
}

run()