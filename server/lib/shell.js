//functionality of manticore with asynchronous behavior and dependencies for integration testing
var consuler;
var nomader = require('nomad-helper');
var core = require('./core.js');
var needle = require('needle');
var uuid = require('node-uuid');
var randomString = require('randomstring');
var exec = require('child_process').exec;
var fs = require('fs');
var ip = require('ip');
var logger = require('../lib/logger');
var nomadAddress;
var self;
var io;

module.exports = {
	init: function (address, socketIo, callback) {
		consuler = require('consul-helper')(address);
		//set the address
		nomadAddress = address + ":4646";
		logger.debug("Nomad address: " + nomadAddress);
		self = this; //keep a consistent context around
		io = socketIo;

		consuler.setKeyValue("manticore/filler", "Keep me here please!", function () {
			callback();
		});
	},
	startWatches: function (postUrl) {
		//set a watch for the KV store
		consuler.watchKVStore("manticore/", keysWatch);

		function keysWatch (keys) {
			//if keys is undefined, set it to an empty array
			keys = keys || [];
			keys = core.filterKeys(keys, "manticore/requests/");
			logger.debug("KV store update (after filtering)");
			logger.debug(keys);

			//set up an expectation that we want the values of <keys.length> keys.
			//send a callback function about what to do once we get all the values
			var expecting = core.expect(keys.length, function (job) {
				core.checkJobs(job, function () {//there are tasks. submit the job
					logger.debug("Core tasks exist");
					job.submitJob(nomadAddress, function () {});
				}, function () { //there are no tasks. delete the job
					logger.debug("No core tasks");
					self.deleteJob("core", function () {});
				});
			});
			for (let i = 0; i < keys.length; i++) {
				//go through each key and get their value. send the value to expecting
				//expecting will keep track of how many more keys are left
				consuler.getKeyValue(keys[i], function (value) {
					expecting.send(keys[i], value);
				});
			}		
		}

		//set up a watch for all services
		consuler.watchServices(serviceWatch);

		function serviceWatch (services) {
			logger.debug("Services update");
			//services updated. get information about core and hmi if possible
			let cores = services.filter("core-master");
			let hmis = services.filter("hmi-master");
			console.log(cores);
			logger.debug("Core services: " + cores.length);
			logger.debug("Hmi services: " + hmis.length);
			//for every core service, ensure it has a corresponding HMI
			var job = nomader.createJob("hmi");
			core.addHmisToJob(job, cores);
			//submit the job. if there are no task groups then
			//we want to remove the job completely. delete the job in that case
			core.checkJobs(job, function () {//there are tasks
				logger.debug("HMI tasks exist");
				job.submitJob(nomadAddress, function () {});
			}, function () { //there are no tasks
				logger.debug("No HMI tasks");
				self.deleteJob("hmi", function () {});
			});

			var pairs = core.findPairs(cores, hmis, function (userId) {
				//remove user from KV store because the HMI has no paired core which
				//indicates that the user exited the HMI page and is done with their instance
				self.deleteKey("manticore/requests/" + userId, function () {});
			});
			pairs = {
				pairs: pairs
			};
			//post all pairs at once
			logger.info(pairs);
			needle.post(postUrl, pairs, function (err, res) {
			});

			//if NGINX_OFF was not set to "true". write the file and reload nginx
			core.checkNginxFlag(function () {
				//create an nginx file and write it so that nginx notices it
				//use the pairs because that has information about what addresses to use
				//NOTE: the user that runs manticore should own this directory or it may not write to the file!
				logger.debug("Updating Nginx conf file");
				var nginxFile = core.generateNginxFile(pairs);
			    fs.writeFile("/etc/nginx/conf.d/manticore.conf", nginxFile, function(err) {
			    	//done! restart nginx
			    	exec("sudo service nginx reload", function () {});
			    }); 
			}, function () {//NGINX_OFF is set to true. do nothing
			});
		}
	},
	requestCore: function (userId, body) {
		//store the userId and request info in the database. wait for this app to find it
		//also generate unique strings to append to the external IP address that will
		//be given to users. NGINX will map those IPs to the correct internal IP addresses
		//of core and hmi
		//generate random letters and numbers for the user and hmi addresses
		//get all keys in the KV store and find their external address prefixes
		consuler.getKeyAll("manticore/requests/", function (results) {
			var addresses = core.getAddressesFromUserRequests(results);
			var options1 = {
				length: 12,
				charset: 'alphanumeric',
				capitalization: 'lowercase'
			}
			var options2 = {
				length: 4,
				charset: 'numeric'
			}

			var func1 = randomString.generate.bind(undefined, options1);
			const userToHmiAddress = core.getUniqueString(addresses, func1); //userAddress prefix
			const hmiToCoreAddress = core.getUniqueString(addresses, func1); //hmiAddress prefix
			//since SOME APPS have character limits (15) use a smaller random string generator for the TCP address
			var func2 = randomString.generate.bind(undefined, options2);
			const userToCoreAddress = core.getUniqueString(addresses, func2); //tcpAddress prefix
			body.userToHmiPrefix = userToHmiAddress;
			body.hmiToCorePrefix = hmiToCoreAddress;
			body.userToCorePrefix = userToCoreAddress;
			logger.debug("Store request " + userId);
			consuler.setKeyValue("manticore/requests/" + userId, JSON.stringify(body));
		});

	},
	//send back connection information in order for the client to make a websocket connection to
	//receive sdl_core logs
	requestLogs: function (clientID) {
		//point the user to the appropriate address
		var address = core.getWsUrl();
		//before we're done here, setup a connection for this client to receive logs from core
		//use the clientID as the socket namespace in order to distinguish users
		acceptConnections(clientID);
		return address;
	},
	deleteKey: function (key, callback) {
		consuler.delKey(key, function () {
			callback();
		});
	},
	deleteJob: function (jobName, callback) {
		nomader.deleteJob(jobName, nomadAddress, function () {
			callback();
		});
	}
}
var counter = 0;
function acceptConnections (customName) {
			/*
	//get the stream of core
	nomader.getAllocations("core", nomadAddress, function (res) {
		console.log(res.getProperty("ID"));
	});*/
	var custom = io.of('/' + customName);
	custom.on('connection', function (socket) {
		socket.emit('logs', "I found you! " + counter);
		counter++;
	});
}