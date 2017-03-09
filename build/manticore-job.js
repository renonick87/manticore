//load the environment variables from the .env file in the same directory
require('dotenv').config();
var nomader = require('nomad-helper'); //for submitting manticore to nomad
var needle = require('needle');
var fs = require('fs');

console.log("Environment variable NODE_LOGS=" + process.env.NODE_LOGS);
console.log("Manticore's environment variables:");
console.log("CLIENT_AGENT_IP: " + process.env.CLIENT_AGENT_IP);
console.log("DOMAIN_NAME: " + process.env.DOMAIN_NAME);
console.log("ELB_SSL_PORT: " + process.env.ELB_SSL_PORT);
console.log("HTTP_PORT: " + process.env.HTTP_PORT);
console.log("TCP_PORT_RANGE_START: " + process.env.TCP_PORT_RANGE_START);   
console.log("TCP_PORT_RANGE_END: " + process.env.TCP_PORT_RANGE_END);   
console.log("HAPROXY_HTTP_LISTEN: " + process.env.HAPROXY_HTTP_LISTEN);   
console.log("HAPROXY_OFF: " + process.env.HAPROXY_OFF);   
console.log("CORS: " + process.env.CORS);   
console.log("AWS_REGION: " + process.env.AWS_REGION);   
console.log("ELB_MANTICORE_NAME: " + process.env.ELB_MANTICORE_NAME);

var nomadAddress = process.env.CLIENT_AGENT_IP + ":4646";
buildManticoreJobFile();
/*
var file = fs.readFileSync("../../example.json");
needle.post("http://192.168.1.144:4646/v1/jobs", file.toString(), function (err, res) {
	console.log(res.body);
});
*/
function buildManticoreJobFile () {
	var job = nomader.createJob("manticore");
	var groupName = "manticore-group";
	var taskName = "manticore-task";
	var serviceName = "manticore-service";
	job.addGroup(groupName);
	job.setType("service");
	//update one manticore at a time every 10 seconds
	job.setUpdate(1, 10000000000);
	job.setCount(groupName, 1);
	//restart manticore if it has failed up to 3 times within 30 seconds, with 5 seconds between restart attempts
	job.setRestartPolicy(groupName, 30000000000, 3, 5000000000, "delay"); 
	job.addTask(groupName, taskName);
	job.setImage(groupName, taskName, "crokita/manticore:master");
	//http port that is internally 4000, but dynamically allocated on the host
	job.addPort(groupName, taskName, true, "http", 4000);
	//add all environment variables from .env here
	addEnvs(job, groupName, taskName, [
		"NODE_LOGS",
		"CLIENT_AGENT_IP",
		"DOMAIN_NAME",
		"ELB_SSL_PORT",
		"HTTP_PORT",
		"TCP_PORT_RANGE_START",
		"TCP_PORT_RANGE_END",
		"HAPROXY_HTTP_LISTEN",
		"HAPROXY_OFF",
		"CORS",
		"AWS_REGION",
		"ELB_MANTICORE_NAME",
		"SSL_CERTIFICATE_ARN",
		"JWT_SECRET",
		"TRACE_SERVICE_NAME",
		"TRACE_API_KEY"
	]);
	job.addService(groupName, taskName, serviceName);
	job.setPortLabel(groupName, taskName, serviceName, "http");
	job.addCheck(groupName, taskName, serviceName, {
		Type: "http",
		Name: "manticore-alive",
		Interval: 3000000000, //in nanoseconds
		Timeout: 2000000000, //in nanoseconds
		Path: "/",
		Protocol: "http"
	});
	//set resource constraints
	job.setCPU(groupName, taskName, 100);
	job.setMemory(groupName, taskName, 100);
	job.setMbits(groupName, taskName, 2);
	job.setEphemeralDisk(groupName, 150, false, false);
	job.setLogs(groupName, taskName, 10, 5);
	job.addConstraint({
		LTarget: "${meta.manticore}",
		Operand: "=",
		RTarget: "1"
	}, groupName);
	job.submitJob(nomadAddress, function (result) {
		console.log("Job submitted");
		console.log(result);
	});
	/*
	job.planJob(nomadAddress, "manticore", function (result) {
		console.log("Job planned")
		console.log(result.FailedTGAllocs);
	});
	*/
	//fs.writeFileSync("output.json", JSON.stringify(job.getJob(), null, 4));
	//console.log(job.getJob().Job.TaskGroups[0]);
}

function addEnvs (job, group, task, names) {
	for (let i = 0; i < names.length; i++) {
		job.addEnv(group, task, names[i], process.env[names[i]]);
	}
}