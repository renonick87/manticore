/** @module app/requestCore/core */
module.exports = {
	/**
	* Goes through the requests array to see if the ID exists in the array
	* @param {string} id - ID of the user
	* @param {object} requests - Request list object obtained from the KV store
	*/
	checkUniqueRequest: function (id, requests) {
		if (requests === undefined) {
			requests = [];
		}
		//return true only if there is no request with the given id found in the KV store
		for (let i = 0; i < requests.length; i++) {
			if (requests[i].Key === id) {
				return false;
			}
		}
		return true;
	},
	/**
	* Find the userToHmi, hmiToCore, and brokerAddress prefixes from all user requests
	* @param {array} keys - Consul KVs in the request list
	*/
	parseAddressesFromUserRequests: function (keys) {
		var addresses = [];
		if (keys !== undefined) {
			for (let i = 0; i < keys.length; i++) {
				let value = JSON.parse(keys[i].Value);
				addresses.push(value.userToHmiPrefix);
				addresses.push(value.hmiToCorePrefix);
				addresses.push(value.brokerAddressPrefix);
			}
		}
		return addresses;
	},
	/**
	* Generate a new string from a function input and make sure it's not in the blacklist
	* @param {array} blackList - Forbidden strings
	* @param {callback} generatorFunc - function to generate a string
	* @returns {string} - A unique string
	*/
	getUniqueString: function (blackList, generatorFunc) {
		//use generatorFunc to keep creating new strings until
		//there is one that isn't part of the blackList, and return it
		var str = generatorFunc();
		while (blackList.find(checkList)) {
			str = generatorFunc();
		}
		return str;
		function checkList (item) {
			return str === item;
		}
	},
	/**
	* Generate a unique port not in the blacklist given a range
	* Warning: may be slow
	* Computation time proportional to <possibilityNumber> * <blackList.length>
	* @param {number} lowerBound - The minimum the port number can be
	* @param {number} upperBound - The maximum the port number can be
	* @param {array} blackList - Forbidden numbers
	* @returns {number} - A unique number
	*/
	getUniquePort: function (lowerBound, upperBound, blackList) {
		var possibilityNumber = upperBound - lowerBound + 1;
		if (upperBound < lowerBound) {
			throw "Upper bound is less than lower bound";
		}
		//when mass generating numbers like these, don't leave it up to probability to find a unique number
		//generate all possible numbers and remove elements based on the blacklist
		var possibilities = [];
		for (let i = lowerBound; i <= upperBound; i++) {
			possibilities.push(i);
		}
		//remove blacklist numbers
		possibilities = possibilities.filter(function (num) {
			return blackList.indexOf(num) === -1;
		});
		if (possibilities.length === 0) {
			//no possible number can be made
			throw "No possible number can be created given the blacklist";
		}
		var randomIndex = Math.floor(Math.random()*possibilities.length);
		return possibilities[randomIndex];
	},
	/**
	* Extract TCP external port numbers from an array of keys
	* @param {array} keys - Consul KVs in the request list
	* @returns {array} - All the TCP ports used
	*/
	getTcpPortsFromUserRequests: function (keys) {
		var ports = [];
		if (keys !== undefined) {
			for (let i = 0; i < keys.length; i++) {
				let value = JSON.parse(keys[i].Value);
				ports.push(value.tcpPortExternal);
			}
		}
		return ports;
	}
}