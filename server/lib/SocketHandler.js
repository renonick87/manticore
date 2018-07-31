var needle = require('needle');
var randomString = require('randomstring');

var options = {
    length: 24,
    charset: 'alphanumeric'
};
//generate random strings for connection urls
var generatorFunc = randomString.generate.bind(undefined, options);

module.exports = SocketHandler;

//stores constants of how long a user can keep an instance of core/hmi while idle
var usageDuration;
var warningDuration;
var timeoutEventListener;

/**
* Manages websocket connections across users and sends information about their core/hmi locations
* @constructor
* @param {object} io - A socket.io instance
* @param {object} timeoutEvent - An event emitter that informs server/app/watches/shell.js when a user should be removed
* @param {number} usageDur - The number of seconds a user is allowed to use this service without interruption
* @param {number} warningDur - The number of seconds the user has after usageDur to respond before being removed 
*/
function SocketHandler (io, timeoutEvent, usageDur, warningDur) {
    this.websocket = io;
    timeoutEventListener = timeoutEvent;
    this.sockets = {};
    usageDuration = usageDur;
    warningDuration = warningDur;
}

/**
* Starts a websocket server that is able to stream information to the client
* @param {string} id - The id of the user that is connecting to Manticore
*/
SocketHandler.prototype.requestConnection = function (id) {
    var self = this;
    //all connection socket instances will have a connection string on instantiation
    //getConnectionString will force instantiation if needed
    var custom = this.websocket.of('/' + this.getConnectionString(id));
    custom.on('connection', function (socket) {
        //save this socket object
        self.addSocket(id, socket);
        //resend connection information if it exists!
        self.send(id, "connectInfo");
        self.send(id, "position");
        //custom user event where the user did something
        socket.on('activity', function () {
            //user responded with an activity event! reset the timers!
            self.resetTimers(id);
        });
    });
    custom.on('disconnect', function () {
        //remove socket, but only the socket. keep the connection information/position
        self.removeSocket(id);
    });
}

/**
* Remove outdated information of connection objects that shouldn't exist anymore
* @param {array} requestKeyArray - Array of ids whose websocket servers should be open for
*/
SocketHandler.prototype.cleanSockets = function (requestKeyArray) {
    //now check if each element in the sockets object exists in the requests
    //if it doesn't, remove the cached information
    for (var key in this.sockets) {
        if (requestKeyArray.indexOf(key) === -1) {
            //not found. remove the cached information
            delete this.sockets[key].position;
            delete this.sockets[key].addresses;
            delete this.sockets[key].connectionString;
            //clear timers
            this.clearTimers(key);
            
            if (this.checkId(key) && this.sockets[key].socket) {
                //additionally, inform the user that their core is dead!
                var connection = this.sockets[key];
                connection.socket.emit("shutdown", "");
            }
        }
    }
}

/**
* Make a connection socket object but without the socket itself
* @param {string} id - Id of a user using Manticore
* @param {object} socket - socket of the connection to the user
*/
SocketHandler.prototype.newSocket = function (id, socket) {
    //a user should communicate with the same Manticore in a cluster, so store the random connection
    //string in memory via the ConnectionSocket. unlike other random strings generated, we will not
    //check for uniqueness here
    this.sockets[id] = new ConnectionSocket(id, socket, generatorFunc());
}

/**
* Remove the ConnectionSocket attached to the id of a user
* @param {string} id - Id of a user using Manticore
*/
SocketHandler.prototype.removeConnection = function (id) {
    if (this.checkId(id)) {
        //remove all information. call this if the user is not in the waiting list anymore
        this.clearTimers(id); //remove timers first so they dont just keep running
        delete this.sockets[id];
    }
}

/**
* Add a socket and attach it to the id of a user
* @param {string} id - Id of a user using Manticore
* @param {object} socket - socket of the connection to the user
*/
SocketHandler.prototype.addSocket = function (id, socket) {
    if (this.checkId(id)) { 
        //this id was found before! associate the id with the new socket
        this.sockets[id].socket = socket;
    }
    else { //if the id doesn't exist in the cache, then make a brand new ConnectionSocket
        this.newSocket(id, socket);
    }
}

/**
* Remove the socket attached to the id of a user in the ConnectionSocket
* @param {string} id - Id of a user using Manticore
*/
SocketHandler.prototype.removeSocket = function (id) {
    if (this.checkId(id)) {
        //only remove the socket itself! cache the other information
        //in case the user reconnects and needs them back
        delete this.sockets[id].socket;
    }
}

/**
* Send the user new information about the position in the waiting list
* @param {string} id - Id of a user using Manticore
* @param {number} data - The new position of the id of the user in the waiting list
*/
SocketHandler.prototype.updatePosition = function (id, data) {
    if (!this.checkId(id)) { //make a new connection socket if it doesn't exist
        this.newSocket(id);
    }
    //only send info if it's new info
    var newInfo = (this.sockets[id].position !== data);
    this.sockets[id].position = data;
    if (newInfo) {
        this.send(id, "position");
    }
}

/**
* Send the user new information about their core/hmi address locations
* @param {Context} context - Context instance
* @param {string} id - Id of a user using Manticore
* @param {object} data - The new position of the id of the user in the waiting list
*/
SocketHandler.prototype.updateAddresses = function (context, id, data) {
    var self = this;
    if (!this.checkId(id)) { //make a new connection socket if it doesn't exist
        this.newSocket(id);
    }
    //only send info if it's new info
    var newInfo = (JSON.stringify(this.sockets[id].addresses) !== JSON.stringify(data));
    this.sockets[id].addresses = data;
    if (newInfo) {
        //for new address information, make an http check to that HMI to ensure that 
        //the address info actually gets routed by HAProxy to the HMI before sending the addresses
        if (context.config.haproxy) {
            waitForHmiCheck(context, id, function () {
                self.send(id, "connectInfo");
            });
        }
        else {
            this.send(id, "connectInfo");
        }
    }
}

/**
* Gets the connection string suffix for a specific user. Will force an instantiation of ConnectionSocket
* in order to guarantee the existance of the connection string
* @param {string} id - Id of a user using Manticore
* @returns {string} - Connection string suffix
*/
SocketHandler.prototype.getConnectionString = function (id) {
    if (!this.checkId(id)) { //make a new connection socket if it doesn't exist
        this.newSocket(id);
    }
    //there could be a connection socket but no connection string. if it doesn't exist
    //then the user started and stopped a core, which cleared out the connection string.
    //generate a new one!
    if (!this.sockets[id].connectionString) {
        this.sockets[id].connectionString = generatorFunc();
    }
    return this.sockets[id].connectionString;
}

/**
* Tries to find a ConnectionSocket associated with an id
* @param {string} id - Id of a user using Manticore
* @returns {ConnectionSocket} - A connection socket object of the id, if it exists. May be null
*/
SocketHandler.prototype.checkId = function (id) {
    return this.sockets[id];
}

/**
* Sends address information and position, if any
* @param {string} id - Id of a user using Manticore
* @param {string} keyword - String that informs the function what kind of information to transmit
* @param {string} logData - Optional. The log stream data from the Nomad HTTP API
*/
SocketHandler.prototype.send = function (id, keyword, logData) {
    //if there is any connection info, regardless of whether a user is listening over a websocket,
    //start the timers if they are enabled!
    if (this.checkId(id) && keyword === "connectInfo" && this.sockets[id].addresses) {
        this.startTimers(id);
    } 

    //also check if the socket exists
    if (this.checkId(id) && this.sockets[id].socket) {
        var connection = this.sockets[id];
        //only send the information if it exists
        //for the position that is a number and 0 is a possible value which is falsy.
        //we don't want to interpret 0 as falsy, so check for undefined/null instead
        if (keyword === "position" && connection.position !== undefined && connection.position !== null) {
            connection.socket.emit(keyword, connection.position);
        }  
        if (keyword === "connectInfo" && connection.addresses) {
            connection.socket.emit(keyword, connection.addresses);
        } 
        //logs don't need to be stored since Nomad stores them for us
        if (keyword === "logs") {
            connection.socket.emit(keyword, logData);
        } 
        if (keyword === "inactivity") { 
            //they have usageDuration seconds left to respond!
            connection.socket.emit(keyword, usageDuration);
        }
    }
}


//timer-related methods

/**
* Given environment variables are set for timers, starts a timer for a user able to use Manticore's service
* without interruption, and a timer for warning the user when they're about to be removed due to inactivity
* @param {string} id - Id of a user using Manticore
*/
SocketHandler.prototype.startTimers = function (id) {
    //if usageDuration and warningDuration are defined, start some timers!
    var self = this;
    if (usageDuration && warningDuration) {
        //make sure timers don't exist already
        if (!self.sockets[id].usageTimer) {
            self.sockets[id].usageTimer = self.createUsageTimer(id);
        }
        if (!self.sockets[id].warningTimer) {
            self.sockets[id].warningTimer = self.createWarningTimer(id);
        }
    }
}

/**
* Starts a timer for a user able to use Manticore's service without interruption
* @param {string} id - Id of a user using Manticore
*/
SocketHandler.prototype.createUsageTimer = function (id) {
    var self = this;
    return setTimeout(function () {
        //when this is invoked, send a message to the user that they have
        //a limited time to respond before being removed from the request list
        self.send(id, "inactivity");
    }, usageDuration*1000);
}

/**
* Starts a timer for warning the user when they're about to be removed due to inactivity
* The total amount of time before a user is removed from the waiting list due to inactivity is 
* the usageDuration count plus the warningDuration count
* @param {string} id - Id of a user using Manticore
*/
SocketHandler.prototype.createWarningTimer = function (id) {
    return setTimeout(function () {
        //when this is invoked, remove the user from the request list
        //as they timed out due to idling
        //send an event to the shell to remove the user since we cannot execute that code
        //from here normally
        if (timeoutEventListener) {
            timeoutEventListener.emit('removeUser', id);
        }
        //timers should be removed by parent modules once a cleanSockets() happens
    }, usageDuration*1000 + warningDuration*1000);
}

/**
* Removes all active timers for a particular user
* @param {string} id - Id of a user using Manticore
*/
SocketHandler.prototype.clearTimers = function (id) {
    if (this.sockets[id].usageTimer) {
        clearTimeout(this.sockets[id].usageTimer);
        delete this.sockets[id].usageTimer;
    }
    if (this.sockets[id].warningTimer) {
        clearTimeout(this.sockets[id].warningTimer);
        delete this.sockets[id].warningTimer;
    }
}

/**
* Removes all active timers for a particular user and then starts those timers again
* @param {string} id - Id of a user using Manticore
*/
SocketHandler.prototype.resetTimers = function (id) {
    this.clearTimers(id);
    this.startTimers(id);
}

/**
* Inner class that contains the socket, as well as other important information.
* Includes a position property which stores information about a user's position in the waiting list
* Includes an addresses property which stores an object about address information for a user
* @constructor
* @param {object} socket - The socket from a connection to the user
* @param {string} randomString - A random string that is the suffix of the websocket connection for a user
*/
function ConnectionSocket (id, socket, randomString) {
    this.id = id;
    this.socket = socket;
    this.position;
    this.addresses;
    this.connectionString = randomString;
    this.usageTimer;
    this.warningTimer;
}

/**
* Gets the specific allocation of the HMI and calls back when an HTTP connection 
* can get to the HMI through HAProxy. This is a recursive function
* @param {Context} context - Context instance
* @param {string} userId - ID of a user
* @param {function} callback - empty callback
*/
function waitForHmiCheck (context, userId, callback) {
    //check the userId in request every time in case something happened to the user while checking the HMI
    context.consuler.getKeyValue(context.keys.data.request + "/" + userId, function (result) {
        if (result) {
            var requestObj = context.UserRequest().parse(result.Value);
            var url;

            if (context.config.aws && context.config.aws.elb) {
                url = `https://${requestObj.userToHmiPrefix}.${context.config.haproxy.domainName}`;
            }
            else {
                url = `http://${requestObj.userToHmiPrefix}.${context.config.haproxy.domainName}`;
            }
            //keep continually hitting the endpoint until we get a 200 response
            needle.get(url, function (err, res) {
                if (err) { //try again after .5 seconds
                    setTimeout(function () {
                        waitForHmiCheck(context, userId, callback);
                    }, 500);
                }
                else {
                    context.logger.debug("HMI CHECK FOR " + userId + ": " + url + " : " + res.statusCode);
                    if (res.statusCode === 200) { //status code is good!
                        callback();
                    }
                    else { //try again after .5 seconds
                        setTimeout(function () {
                            waitForHmiCheck(context, userId, callback);
                        }, 500);
                    }
                }
            }); 
        }
        else { //no user exists anymore...
            callback();
        }
    });
}