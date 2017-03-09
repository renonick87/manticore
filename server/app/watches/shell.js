var functionite = require('functionite');
var core = require('./core.js');
//SUBFOLDER MODULES
var jobLogic = require('./job/shell.js');
var proxyLogic = require('./proxy/shell.js');

//watches that are handled by this module
var serviceWatches = {};

/** @module app/watches/shell */

module.exports = {
	/**
	* Sets up watches for Consul's KV store in the request, waiting, and allocation list
	* @param {Context} context - Context instance
	*/
	startKvWatch: function (context) {
		//set up watches for the KV store
		//pass in the context to the watch functions
		context.consuler.watchKVStore(context.keys.request, requestsWatch(context));
		context.consuler.watchKVStore(context.keys.waiting, waitingWatch(context));
		context.consuler.watchKVStore(context.keys.allocation, allocationWatch(context));
	},
	/**
	* Sets up watches for Consul's services for core, hmi, and manticore services
	* @param {Context} context - Context instance
	*/
	startServiceWatch: function (context) {
		//first, consistently watch all the manticore services!
		context.consuler.watchServiceStatus("manticore-service", manticoreWatch(context));

		//set up a watch for all services
		var watch = context.consuler.watchAllServices(function (services) {
			var currentWatchesArray = Object.keys(serviceWatches);
			var serviceArray = Object.keys(services);
			//only get core services and hmi services
			var coresAndHmis = serviceArray.filter(function (element) {
				return element.startsWith("core-service") || element.startsWith("hmi-service");
			});

			core.updateWatches(currentWatchesArray, coresAndHmis, stopper, starter);

			function stopper (serviceName) {
				//this service doesn't exist anymore. stop the watch
				serviceWatches[serviceName].end();
				delete serviceWatches[serviceName];
			}
			function starter (serviceName) {
				//this service exists with no watch. start it
				var functionCallback;
				//extract userID for future reference
				if (serviceName.startsWith("core-service")) {
					var userId = serviceName.split("-")[2];
					functionCallback = coreWatch(context, userId);
				}
				if (serviceName.startsWith("hmi-service")) {
					var userId = serviceName.split("-")[2];
					functionCallback = hmiWatch(context, userId);
				}
				//start the watch!
				var watch = context.consuler.watchServiceStatus(serviceName, functionCallback);
				serviceWatches[serviceName] = watch;
			}
		});
	}
}

//wrap the context in these functions so we have necessary functionality
//warning: releasing locks triggers an update for the KV store
/**
* The watch invoked when a change is found in the request list
* @param {Context} context - Context instance
*/
function requestsWatch (context) {
	return function (requestKeyArray) { //given from Consul
		context.logger.debug("request watch hit");
		//trim the prefixes of the requestKeyArray so we just get the inner-most key names
		for (let i = 0; i < requestKeyArray.length; i++) {
			requestKeyArray[i] = requestKeyArray[i].split(context.keys.data.request + "/")[1];
		}
		//get waiting key and value
		functionite()
		.pass(context.consuler.getKeyValue, context.keys.data.waiting)
		.pass(function (waitingValue) {
			var waitingHash = context.WaitingList(waitingValue);
			//use the updated request list to remove any connection sockets that have info about a user
			waitingHash.update(requestKeyArray, function (lostKey) {
				//key not found. remove the allocation information
				//from the KV store. stop the job if it also exists
				//this function should be the ONLY authority on whether to delete the job
				//any other function that wants to stop a job should remove the key from the KV store instead
				waitingHash.remove(lostKey);
				context.consuler.delKey(context.keys.data.allocation + "/" + lostKey, function (){});
				context.nomader.deleteJob("core-hmi-" + lostKey, context.nomadAddress, function (){});
			});

			context.socketHandler.cleanSockets(requestKeyArray);
			context.logger.debug("Waiting list update");
			context.logger.debug(waitingHash.get());
			//update manticore/waiting/data using the updated object generated
			context.consuler.setKeyValue(context.keys.data.waiting, waitingHash.get(), function () {});
		})
		.go()
	}
}

/**
* The watch invoked when a change is found in the waiting list
* @param {Context} context - Context instance
*/
function waitingWatch (context) {
	return function () {
		context.logger.debug("waiting watch hit");
		var requestKV;
		//get request keys and values
		functionite()
		.pass(context.consuler.getKeyAll, context.keys.request)
		.pass(functionite(core.transformKeys), context.keys.data.request)
		.pass(function (requestKeys, callback) {
			//store requestKeys for future use
			requestKV = requestKeys;
			callback();
		})
		//get waiting list. the waiting list is one value as a stringified JSON
		.toss(context.consuler.getKeyValue, context.keys.data.waiting)
		.pass(function (waitingObj, callback) {
			var waitingHash = context.WaitingList(waitingObj);
			context.logger.debug("Find next in waiting list");
			//get the request with the lowest index (front of waiting list)
			var lowestKey = waitingHash.nextInQueue();
			//there may be a request that needs to claim a core, or there may not
			//designate logic of allocating cores to the allocation module
			//pass all the information needed to the allocation module
			callback(lowestKey, waitingHash, requestKV, context);
		}) //"this" keyword won't work for attemptCoreAllocation when passed through
		//functionite. use the "with" function in functionite to establish context
		.pass(jobLogic.attemptCoreAllocation).with(jobLogic)
		.pass(function (newWaitingHash, updateWaitingList) {
			//recalculate the positions of the new waiting list and send that over websockets
			var positionMap = newWaitingHash.getQueuePositions();
			//store and submit the position information of each user by their id
			for (var id in positionMap) {
				context.socketHandler.updatePosition(id, positionMap[id]);
			}
			//only update the waiting list if it needs to be updated.
			if (updateWaitingList) {
				context.logger.debug("Waiting list update!");
				//update the waiting list
				context.consuler.setKeyValue(context.keys.data.waiting, newWaitingHash.get(), function (){});
			}
		})
		.go();
	}
}

/**
* The watch invoked when a change is found in the allocation list
* @param {Context} context - Context instance
*/
function allocationWatch (context) {
	return function () {
		context.logger.debug("allocation watch hit");
		var requestsKV;
		//get allocation keys and values and request keys and values
		functionite()
		.pass(context.consuler.getKeyAll, context.keys.request)
		.pass(functionite(core.transformKeys), context.keys.data.request)
		.pass(function (requestKeys, callback) {
			//store requestKeys for future use
			requestsKV = requestKeys;
			callback();
		})
		.pass(context.consuler.getKeyAll, context.keys.allocation)
		.pass(functionite(core.transformKeys), context.keys.data.allocation)
		.pass(function (allocationKeys, callback) {
			//each key has a value that is stringified JSON in the format of the AllocationData class
			//go through each property found (key is the id of the user)
			//we also need information from the requests KV in order to complete this information

			var pairs = [];
			for (var key in allocationKeys) {
				var userId = key;
				var allocData = context.AllocationData().parse(allocationKeys[userId]); //convert the string into JSON
				//get the corresponding request KV object
				var kv = requestsKV[userId];
				//it's possible that in the time this function ran that some requests KVs got removed
				//from the store, making allocationKeys out of date. simply ignore the results that
				//are undefined since they don't exist anymore
				if (kv) {
					var requestObj = context.UserRequest().parse(kv);
					var pair = {
						id: userId,
						userAddressInternal: allocData.hmiAddress + ":" + allocData.hmiPort,
						hmiAddressInternal: allocData.coreAddress + ":" + allocData.corePort,
						tcpAddressInternal: allocData.coreAddress + ":" + allocData.tcpPort,
						brokerAddressInternal: allocData.hmiAddress + ":" + allocData.brokerPort,
						userAddressExternal: requestObj.userToHmiPrefix,
						hmiAddressExternal: requestObj.hmiToCorePrefix,
						tcpPortExternal: requestObj.tcpPortExternal,
						brokerAddressExternal: requestObj.brokerAddressPrefix
					}
					//pair information!
					//post/store the connection information to the client whose id matches
					//format the connection information and send it!
					context.socketHandler.updateAddresses(pair.id, core.formatPairResponse(pair));
					//done.
					pairs.push(pair);
				}
			}
			context.logger.info(pairs);
			if (context.isHaProxyEnabled()) {
				//update the proxy information using the proxy module (not manticore addresses!)
				context.logger.debug("Updating KV Store with address and port data for proxy!");
				var template = proxyLogic.generateProxyData(context, pairs, []);
				proxyLogic.updateCoreHmiKvStore(context, template);

				//furthermore, if AWS_REGION is defined, use the TCP port information
				//from the template to modify the ELB such that it is listening and routing
				//on those same ports
				if (process.env.AWS_REGION) {
					context.AwsHandler.changeState(template);
				}
			}
		})
		.go();
	}
}

/**
* The watch invoked when a change is found in core services
* @param {Context} context - Context instance
* @param {string} userId - ID of a user
*/
function coreWatch (context, userId) {
	return function (services) {
		//should just be one core per job
		var coreServices = core.filterServices(services, []);
		context.logger.debug("Core service: " + userId + " " + coreServices.length);
		if (coreServices.length > 0) {
			var coreService = coreServices[0];
			var jobName = "core-hmi-" + userId;
			//due to bugs with Consul, we need to make a check with Nomad
			//to make sure that this service has a corresponding job.
			//if it's a rogue service, ignore it, as it likely cannot be removed in any elegant way
			context.nomader.findJob(jobName, context.nomadAddress, function (job) {
				//use the job that was submitted to append an hmi group and resubmit it
				if (job && !checkJobForHmi(job)) { //job exists for this service and doesn't have an HMI. add an hmi and submit
					//get the request object stored for this user id
					context.consuler.getKeyValue(context.keys.data.request + "/" + userId, function (result) {
						var requestObj = context.UserRequest().parse(result.Value);
						//add the hmi group and submit the job
						jobLogic.addHmiGenericGroup(job, coreService, requestObj);
						jobLogic.submitJob(context, job, jobName, function () {});
					});
				}
			});
		}
		else { //core for this user id has died. delete the job now
			context.logger.debug("Core died. Delete job " + userId);
			context.consuler.delKey(context.keys.data.request + "/" + userId, function (){});
		}
	}
}

/**
* The watch invoked when a change is found in hmi services
* @param {Context} context - Context instance
* @param {string} userId - ID of a user
*/
function hmiWatch (context, userId) {
	return function (services) {
		//require an http alive check. should only be one hmi service
		var hmiServices = core.filterServices(services, ['hmi-alive']);
		context.logger.debug("Hmi service: " + userId + " " + hmiServices.length);
		//if this returns 0 services then its probably because the health check failed.
		//don't do anything rash
		if (hmiServices.length > 0) {
			var hmiService = hmiServices[0];
			var jobName = "core-hmi-" + userId;
			//should just be one hmi per job
			//due to bugs with Consul, we need to make a check with Nomad
			//to make sure that this service has a corresponding job.
			//if it's a rogue service, ignore it, as it likely cannot be removed in any elegant way
			context.nomader.findJob(jobName, context.nomadAddress, function (job) {
				if (job) { //job exists for this service
					getConnectionInformation(job, hmiService);
				}
			});
		}

		function getConnectionInformation (job, hmiService) {
			//we need three things. the ID, the request data from the KV store,
			//and the allocation details of this core task
			//this regex will find the allocation ID within the ID of this service
			var hmiAllocID = hmiService.ID.match(/[a-f0-9]+-[a-f0-9]+-[a-f0-9]+-[a-f0-9]+-[a-f0-9]+/g)[0];
			//store important information here
			var data = context.AllocationData({
 				userPort: null,
 				brokerPort: null,
				tcpPort: null,
 				coreAddress: null,
 				corePort: null,
 				hmiAddress: hmiService.Address,
 				hmiPort: hmiService.Port
 			});

			functionite() //get the allocation info
			.pass(context.nomader.getAllocation, hmiAllocID, context.nomadAddress)
			.pass(function (allocationResult, callback) {
				//figure out where the user and broker port data is in the 2-element array
				if (allocationResult.Resources.Networks[0].DynamicPorts[0].Label === "user") {
					data.userPort = allocationResult.Resources.Networks[0].DynamicPorts[0].Value;
					data.brokerPort = allocationResult.Resources.Networks[0].DynamicPorts[1].Value;
				}
				else {
					data.userPort = allocationResult.Resources.Networks[0].DynamicPorts[1].Value;
					data.brokerPort = allocationResult.Resources.Networks[0].DynamicPorts[0].Value;
				}
				callback();
			})//get the core service for this id
			.toss(context.consuler.getService, "core-service-" + userId)
			.pass(function (coreServices, callback) {
				if (coreServices.length > 0) {
					var coreAllocID = coreServices[0].Service.ID.match(/[a-f0-9]+-[a-f0-9]+-[a-f0-9]+-[a-f0-9]+-[a-f0-9]+/g)[0];
					//while we are getting the core service, retrieve the core address and port to be used later
					data.coreAddress = coreServices[0].Service.Address;
					data.corePort = coreServices[0].Service.Port;
					callback(coreAllocID, context.nomadAddress);
				}
				else { //in this case, the HMI is still running but core isn't. we have to stop the job now
					context.logger.debug("Core died. Delete job " + userId);
					context.consuler.delKey(context.keys.data.request + "/" + userId, function (){});
				}

			}) //get the allocation info
			.pass(context.nomader.getAllocation)
			.pass(function (allocationResult) {
				if (allocationResult.Resources.Networks[0].DynamicPorts[0].Label === "tcp") {
					data.tcpPort = allocationResult.Resources.Networks[0].DynamicPorts[0].Value;
				}
				else {
					data.tcpPort = allocationResult.Resources.Networks[0].DynamicPorts[1].Value;
				}
				//take all the information we got and store it in the KV under allocations for the user
				//do not pass in the data stringified in another functionite toss/pass as that
				//result will get evaluated before the data object is populated
				context.consuler.setKeyValue(context.keys.data.allocation + "/" + userId, JSON.stringify(data), function () {});
			})
			.go();
		}
	}
}

/**
* The watch invoked when a change is found in manticore services
* @param {Context} context - Context instance
*/
function manticoreWatch (context) {
	return function (services) {
		var manticores = core.filterServices(services, ['manticore-alive']); //require an http alive check
		context.logger.debug("Manticore services: " + manticores.length);
		//ONLY update the manticore services in the KV store, and only if haproxy is enabled
		if (context.isHaProxyEnabled()) {
			context.logger.debug("Updating KV Store with manticore data for proxy!");
			var template = proxyLogic.generateProxyData(context, [], manticores);
			proxyLogic.updateManticoreKvStore(context, template);
		}
	}
}

/**
* Finds whether this job has an HMI in it
* @param {object} job - Object of the job file intended for submission to Nomad
* @returns {boolean} - Shows whether an HMI exists in the job file
*/
function checkJobForHmi (job) {
	var taskGroupCount = job.getJob().Job.TaskGroups.length;
	var foundHMI = false;
	for (let i = 0; i < taskGroupCount; i++) {
		if (job.getJob().Job.TaskGroups[i].Name.startsWith("hmi-group")) {
			foundHMI = true;
			break;
		}
	}
	return foundHMI;
}