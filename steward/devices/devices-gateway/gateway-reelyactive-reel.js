// reelyActive radio-sensor reels -- http://reelyactive.com/corporate/technology.htm
/* frame/packet decoding based on a pre-release of RA's BarnOwl library:

   (c) reelyActive 2013, We believe in an open Internet of Things

 */


var crypto      = require('crypto')
  , dgram       = require('dgram')
  , fs          = require('fs')
  , serialport  = require('serialport')
  , util        = require('util')
  , devices     = require('./../../core/device')
  , steward     = require('./../../core/steward')
  , utility     = require('./../../core/utility')
  , gateway     = require('./../device-gateway')
  ;


var logger  = utility.logger('gateway');
var logger2 = utility.logger('discovery');


var Hublet = exports.Device = function(deviceID, deviceUID, info) {
  var self = this;

  self.whatami = info.deviceType;
  self.deviceID = deviceID.toString();
  self.deviceUID = deviceUID;
  self.name = info.device.name;
  self.getName();

  self.status = 'ready';
  self.changed();
  self.info = {};
  self.writer = info.writer;

  self.eui64 = '001bc5094';
  self.reels = {};
  self.seen  = {};

  self.update(self, info.params.data, info.params.timestamp);

  utility.broker.subscribe('actors', function(request, taskID, actor, perform, parameter) {/* jshint unused: false */
    if (actor !== ('device/' + self.deviceID)) return;

    if (request === 'perform') return self.perform(self, taskID, perform, parameter);
  });

  self.getState(function(err, state) {
    if (!!err) return logger.error('device/' + self.deviceID, { event: 'getState', diagnostic: err.message });
    if (!state) return;

    self.info.tailceiver = state.tailceiver;
    delete(self.warnedP);
    if (!!self.info.tailceiver) self.reelcall(self);
  });

  setInterval(function() { self.reelcall(self); }, 30 * 1000);
};
util.inherits(Hublet, gateway.Device);
Hublet.prototype.perform = devices.perform;


Hublet.prototype.reelcall = function(self) {
  var device, reelReq, reelID;

  if ((!self.writer) || (!self.info.tailceiver)) return;

  device = devices.id2device(self.info.tailceiver.split('/')[1]);
  if (!device) return;
  if (device.whatami !== '/device/gateway/reelyactive/reelceiver') {
    if (self.warnedP) return;

    self.warnedP = true;
    return logger.error('device/' + self.deviceID,
                        { event: 'tailceiver', tailceiver: self.info.tailceiver, diagnostic: 'not a reelceiver' });
  }

  reelReq = 'f1';
  reelID = device.deviceUID.substr(-8);
  self.writer(reelEncrypt(reelReq + reelID + '0000000000000000000000', '55555555555555555555555555555555'));
};

Hublet.prototype.update = function(self, data, timestamp) {
  var i, info, j, prevID, reelID, tagID, udn, v, value;

  if (data.indexOf('78') === 0) return self.updateReelceiver(self, data, timestamp);
  if (data.indexOf('71') === 0) return logger.error('device/' + self.deviceID, { event: 'reelcall', data: data });
  if ((data.indexOf('04') !== 0) || (data.length < 16)) return;

  prevID = -1;
  v = [];
  for (i = 12, j = data.length - 4; i <= j; i += 4) {
    reelID = parseInt(data.substr(i, 2), 16);
    if (reelID <= prevID) return;

    prevID = reelID;
    if (!self.reels[reelID]) continue;

    udn = self.reels[reelID];
    if ((!devices.devices[udn]) || (!devices.devices[udn].device)) continue;

    value = parseInt(data.substr(i + 2, 2), 16);
    v.push({ deviceID : 'device/' + devices.devices[udn].device.deviceID
           , reading  : (value < 128) ? (value + 128) : (value - 128)
           , reelID   : reelID
           });
  }
  if (v.length === 0) return;
  v.sort(function(a, b) { return (b.reading - a.reading); });

  tagID = self.eui64 + data.substr(4, 7);
  udn = 'uuid:2f402f80-da50-11e1-9b23-' + tagID;
  if (!!devices.devices[udn]) return update(udn, v, timestamp);
// supress phantom tags
  if (!self.seen[udn]) {
    self.seen[udn] = { v: v, timestamp: timestamp };
    return;
  }

  info = { source: self.deviceID, params: { v: v, timestamp: timestamp } };
  info.device = { url          : null
                , name         : 'reel tag (' + tagID.match(/.{2}/g).join('-') + ')'
                , manufacturer : 'reelyActive'
                , model        : { name        : 'reelyActive tag'
                                 , description : 'active RFID tag'
                                 , number      : ''
                                 }
                , unit         : { serial      : ''
                                 , udn         : udn
                                 }
                };
  info.url = info.device.url;
  info.deviceType = '/device/presence/reelyactive/fob';
  info.id = info.device.unit.udn;
  if (!!devices.devices[info.id]) return;

  logger2.info(info.device.name);
  devices.discover(info);
};

Hublet.prototype.updateReelceiver = function(self, data, timestamp) {
 var info, packet, udn;

  var toUInt = function(start, length) { return parseInt(data.substr(start * 2, length * 2), 16);                    };

  var toRSSI = function(start)         { var v = toUInt(data, start, 2); return ((v < 128) ? (v + 128) : (v - 128)); };

  if (data.length < 23) return;

  packet = { reelOffset       : toUInt( 1, 1)
           , deviceIdentifier : self.eui64 + data.substr(5, 7)
           , uptime           : toUInt( 6, 2)
           , sendCount        : toUInt( 8, 2)
           , crcPass          : toUInt(10, 2)
           , crcFail          : toUInt(12, 2)
           , maxRSSI          : toRSSI(14)
           , avgRSSI          : toRSSI(15)
           , minRSSI          : toRSSI(16)
           , maxLQI           : toUInt(17, 1)
           , avgLQI           : toUInt(18, 1)
           , minLQI           : toUInt(19, 1)
           , intTemperature   :(toUInt(20, 1) - 80) / 2
           , radioVoltage     :(toUInt(21, 1) / 34) + 1.8
           };
  udn = 'uuid:2f402f80-da50-11e1-9b23-' + packet.deviceIdentifier;
  if (!self.reels[packet.reelOffset]) self.reels[packet.reelOffset] = udn;
  if (!!devices.devices[udn]) return update(udn, packet, timestamp);

  info = { source: self.deviceID, params: { packet: packet, timestamp: timestamp} };
  info.device = { url          : null
                , name         : 'reelceiver (' + packet.deviceIdentifier.match(/.{2}/g).join('-') + ')'
                , manufacturer : 'reelyActive'
                , model        : { name        : 'reelyActive reelceiver'
                                 , description : 'active RFID reelceiver'
                                 , number      : ''
                                 }
                , unit         : { serial      : ''
                                 , udn         : udn
                                 }
                };
  info.url = info.device.url;
  info.deviceType = '/device/gateway/reelyactive/reelceiver';
  info.id = info.device.unit.udn;
  if (!!devices.devices[info.id]) return;

  logger2.info(info.device.name);
  devices.discover(info);
};

Hublet.prototype.perform = function(self, taskID, perform, parameter) {
  var params;

  try { params = JSON.parse(parameter); } catch(ex) { params = {}; }

  if (perform !== 'set') return devices.perform(self, taskID, perform, parameter);

  if (!!params.name) devices.perform(self, taskID, perform, parameter);

  if (!!params.tailceiver) {
    self.info.tailceiver = params.tailceiver;
    self.setState({ tailceiver: self.info.tailceiver });
    delete(self.warnedP);
    self.reelcall(self);
  }

  return steward.performed(taskID);
};

var validate_perform = function(perform, parameter) {
  var params = {}
    , result = { invalid: [], requires: [] }
    ;

  if (!!parameter) try { params = JSON.parse(parameter); } catch(ex) { result.invalid.push('parameter'); }

  if (perform !== 'set') {
    result.invalid.push('perform');
    return result;
  }

  if (!!params.tailceiver) {
    if ((typeof params.tailceiver !== 'string') || (params.tailceiver.split('/').length !== 2)) {
      result.invalid.push('tailceiver');
    }
  }

  return result;
};


var Reelceiver = exports.Device = function(deviceID, deviceUID, info) {
  var self = this;

  self.whatami = info.deviceType;
  self.deviceID = deviceID.toString();
  self.deviceUID = deviceUID;
  self.name = info.device.name;
  self.getName();

  self.status = 'ready';
  self.changed();
  self.info = {};

  self.update(self, info.params.packet, info.params.timestamp);

  utility.broker.subscribe('actors', function(request, taskID, actor, perform, parameter) {
    if (actor !== ('device/' + self.deviceID)) return;

    if (request === 'perform') return devices.perform(self, taskID, perform, parameter);
  });
};
util.inherits(Reelceiver, gateway.Device);
Reelceiver.prototype.perform = devices.perform;


Reelceiver.prototype.update = function(self, packet, timestamp) {
  self.info.lastSample = timestamp;
  self.info.intTemperature = packet.intTemperature;
  self.changed();
};


var reelEncrypt = function (sInput, sKey) {
  var cipher, result;

  cipher = crypto.createCipheriv('AES-128-ECB', new Buffer(sKey, 'hex'), '');
  cipher.setAutoPadding(false);

  result = cipher.update(new Buffer(sInput, 'hex'), null, 'hex');
  result += cipher.final('hex');

  return new Buffer(result, 'hex');
};


var scan = function(portno) {
  var socket = dgram.createSocket('udp4');
  socket.on('message', function(message, rinfo) {
    onmessage(message, { id          : rinfo.family.toLowerCase() + ':' + rinfo.address + ':' + rinfo.port
                       , address     : rinfo.address
                       , description : 'reel-to-Ethernet hublet'
                       , url         : 'udp://' + rinfo.address + ':' + rinfo.port
                       }, function(buffer) { socket.send(buffer, 0, buffer.length, 50000, rinfo.address,
                                             function(err, octets) {
                                               if (!!err) return logger2.error('gateway-reelyactive-reel',
                                                                               { event: 'send', diagnostic: err.message });
                                               logger2.debug('gateway-reelyactive-reel', { event: 'send', size: octets });
                                             });
                                           });
  }).on('listening', function() {
    var address = this.address();

    logger2.info('reelyactive-reel driver listening on  udp://*:' + address.port);
  }).on('error', function(err) {
    logger2.error('gateway-reelyactive-reel', { event: 'socket', diagnostic: err.message });
  }).bind(portno);

  fs.readFile('/sys/devices/bone_capemgr.9/slots', { encoding: 'utf8' }, function(err, data) {
    if (err) return;

    data = data.toString();
    if (data.indexOf('ttyO1_armhf.com') === -1) return console.log('no ttyO1_armhf.com');

    fs.exists('/dev/ttyO1', function(exists) {
      if (!exists) return console.log('/dev/ttyO1 does not exist');

      new serialport.SerialPort('/dev/ttyO1', { baudrate: 230400 }).on('open', function(err) {
        if (err) return logger2.error('gateway-reelyactive-reel', { event: 'serialport open', diagnostic: err.message });

        this.on('data', function(data) {
          onmessage(data, { id: '/dev/ttyO1', address: 'Reel Cape', description: 'reel-to-cape hublet' }, this.write);
        }).on('close', function() {
          logger2.error('gateway-reelyactive-reel', { event: 'serialport close', diagnostic: err.message });
        });
      }).on('error', function(err) {
        return logger2.error('gateway-reelyactive-reel', { event: 'serialport error', diagnostic: err.message });
      });
    });
  });
};

var onmessage = function(message, reel, writer) {
  var data, info, timestamp, udn;

  data = message.toString('hex');
  timestamp = new Date().getTime();

  udn = 'reelyActive:reel:' + reel.id;
  if (!!devices.devices[udn]) return update(udn, data, timestamp);

  info = { params: { data: data, timestamp: timestamp }, writer: writer };
  info.device = { url          : reel.url
                , name         : reel.description + ' (' + reel.address + ')'
                , manufacturer : 'reelyActive'
                , model        : { name        : 'reelyActive hublet'
                                 , description : reel.description
                                 , number      : ''
                                 }
                , unit         : { serial      : ''
                                 , udn         : udn
                                 }
                };
  info.url = info.device.url;
  info.deviceType = '/device/gateway/reelyactive/hublet';
  info.id = info.device.unit.udn;
  if (!!devices.devices[info.id]) return;

  logger2.info(info.device.name, reel);
  devices.discover(info);
};

// the UDP stream is faster than the database on startup
var update = function(udn, data, timestamp) {
  var device;

  if ((!devices.devices[udn]) || (!devices.devices[udn].device)) {
    return setTimeout(function() { update(udn, data, timestamp); }, 10);
  }

  device = devices.devices[udn].device;
  if (!!device) device.update(device, data, timestamp);
};


exports.start = function() {
  steward.actors.device.gateway.reelyactive = steward.actors.device.gateway.reelyactive ||
      { $info     : { type: '/device/gateway/reelyactive' } };

  steward.actors.device.gateway.reelyactive.hublet =
      { $info     : { type       : '/device/gateway/reelyactive/hublet'
                    , observe    : [ ]
                    , perform    : [ 'wake' ]
                    , properties : { name       : true
                                   , status     : [ 'ready' ]
                                   , tailceiver : true
                                   }
                    }
      , $validate : { perform    : validate_perform
                    }
      };
  devices.makers['/device/gateway/reelyactive/hublet'] = Hublet;

  steward.actors.device.gateway.reelyactive.reelceiver =
      { $info     : { type       : '/device/gateway/reelyactive/reelceiver'
                    , observe    : [ ]
                    , perform    : [ ]
                    , properties : { name           : true
                                   , status         : [ 'ready' ]
                                   , lastSample     : 'timestamp'
                                   , intTemperature : 'celcius'
                                   }
                    }
      , $validate : { perform    : devices.validate_perform
                    }
      };
  devices.makers['/device/gateway/reelyactive/reelceiver'] = Reelceiver;

  scan(7018);
};
