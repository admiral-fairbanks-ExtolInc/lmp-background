const Data = require('./data/gather-data');
const { Gpio } = require('onoff');
const NanoTimer = require('nanotimer');
const MongoClient = Promise.promisifyAll(require('mongodb').MongoClient);
const i2c = Promise.promisifyAll(require('i2c-bus'));
const express = require('express');

const digIn = [5, 6, 13];
const digOut = [16, 19, 20, 26];
const startSigIn = {
  Value: 0,
  Pin: digIn[0],
  Type: 'digIn',
};
const stopSigIn = {
  Value: 0,
  Pin: digIn[1],
  Type: 'digIn',
};
const fullStrokeSigIn = {
  Value: 0,
  Pin: digIn[2],
  Type: 'digIn',
};
const extendPressOut = {
  Value: 0,
  Pin: digOut[0],
  Type: 'digOut',
};
const coolingAirOut = {
  Value: 0,
  Pin: digOut[1],
  Type: 'digOut',
};
const cycleCompleteOut = {
  Value: 0,
  Pin: digOut[2],
  Type: 'digOut',
};
const lmpFltedOut = {
  Value: 0,
  Pin: digOut[3],
  Type: 'digOut',
};
const url = 'mongodb://localhost:27017/mydb';
const i2cTmr = new NanoTimer();
const app = express();
// IO Configuration
const startSigPin = new Gpio(5, 'in');
const stopSigPin = new Gpio(6, 'in');
const fullStrokePin = new Gpio(13, 'in');
const extendPressPin = new Gpio(16, 'out');
const coolingAirPin = new Gpio(19, 'out');
const cycleCompletePin = new Gpio(20, 'out');
const lmpFltedPin = new Gpio(26, 'out');
// End IO Config
const infoBuffers = new Array([Data.childAddresses.length]);

let tempInfo;
let dataloggingInfo;
let i2cReady;
let db;
let dbCreated;
let systemInitialized;
let readingAndLoggingActive;
let i2c1;
let childStatuses;
let logRequestSent;
let heatersMapped;

// Sets up Timed interrupt for Reading/Writing I2C and Storing Data
const i2cPromise = Promise.resolve()
  // Broadcast out Status
  .then(Data.broadcastData([startSigIn.Value, stopSigIn.Value,
    fullStrokeSigIn.Value, dataloggingInfo]))
  // Then, read data from each child controller
  .then(Data.readData(infoBuffers))
  // Then, process the data obtained from the children
  // storing any datalogging info
  .then(Data.processData(infoBuffers))
  // Set this flag false once complete so it can begin again on next interrupt
  .then(() => { readingAndLoggingActive = false; })
  // Then update system variables and write outputs
  .then(() => {
    // Stores Temp info in Pond JS timeseries format


    // Checks if all modules are at setpoint. If so, Parent needs
    // to send out Extend Press signal
    extendPressOut.Value = childStatuses.every(elem => elem.heaterAtSetpoint);
    // Checks if all modules are at release. If so, Parent needs
    // to send out Cooling Air signal
    coolingAirOut.Value = childStatuses.every(elem => elem.heaterAtRelease);
    // Checks if all Modules are at Cycle Complete. If so,
    // Parent needs to send out Cycle Complete Signal
    cycleCompleteOut.Value = childStatuses.every(elem => elem.heaterCycleComplete);
    if (cycleCompleteOut.Value && !logRequestSent) dataloggingInfo = true;
    else if (!cycleCompleteOut.Value && logRequestSent) {
      logRequestSent = false;
    }
    // Checks to see if any modules are faulted. If so, Parent
    // needs to send out LMP Faulted signal
    lmpFltedOut.Value = childStatuses.some(elem => elem.heaterFaulted);
    extendPressPin.write(extendPressOut.Value);
    coolingAirPin.write(coolingAirOut.Value);
    cycleCompletePin.write(cycleCompleteOut.Value);
    lmpFltedPin.write(lmpFltedOut.Value);
  });

app.set("port", process.env.PORT || 3001);

// Express only serves static assets in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static("client/build"));
}

app.get("/api/food", (req, res) => {
  const param = req.query.q;

  if (!param) {
    res.json({
      error: "Missing required parameter `q`"
    });
    return;
  }

  // WARNING: Not for production use! The following statement
  // is not protected against SQL injections.
  const r = db.exec(
    `
    select ${COLUMNS.join(", ")} from entries
    where description like '%${param}%'
    limit 100
  `
  );

  if (r[0]) {
    res.json(
      r[0].values.map(entry => {
        const e = {};
        COLUMNS.forEach((c, idx) => {
          // combine fat columns
          if (c.match(/^fa_/)) {
            e.fat_g = e.fat_g || 0.0;
            e.fat_g = (parseFloat(e.fat_g, 10) +
              parseFloat(entry[idx], 10)).toFixed(2);
          } else {
            e[c] = entry[idx];
          }
        });
        return e;
      })
    );
  } else {
    res.json([]);
  }
});

app.listen(app.get("port"), () => {
  console.log(`Find the server at: http://localhost:${app.get("port")}/`); // eslint-disable-line no-console
});

// Setup Loop
Promise.resolve()
  .then(() => {
    i2c1 = i2c.open(1)
      .then((err) => { // Opens I2C Channel
        if (err) throw (err);
        else i2cReady = true;
      });
  })
  .then(MongoClient.connect(url)
    .then((err, database) => {
      if (err) throw (err);
      db = database;
      dbCreated = true;
    }))
  .then(Data.populateDatabase())
  .then(() => {
    if (heatersMapped && i2cReady) systemInitialized = true;
    else console.log('System did not setup correctly');
  });

// Watch Input Pins, Update value accordingly
startSigPin.watch((err, value) => {
  if (err) throw err;
  startSigIn.value = value;
});
stopSigPin.watch((err, value) => {
  if (err) throw err;
  stopSigIn.value = value;
});
fullStrokePin.watch((err, value) => {
  if (err) throw err;
  fullStrokeSigIn.value = value;
});
// End Watch Input Pins

i2cTmr.setInterval(() => {
  if (!readingAndLoggingActive && systemInitialized) {
    readingAndLoggingActive = true;
    i2cPromise();
  }
}, '', '50m');
// Ends Temp Info Interrupt setup

module.exports = {
  tempInfo,
  dataloggingInfo,
  i2c1,
  db,
  heatersMapped,
  logRequestSent,
  infoBuffers,
  childStatuses,
};
