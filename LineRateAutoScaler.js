/*
 AWS AutoScaling on LineRate
 This script will interact with AWS EC2's Auto Scaling feature in
 order to add and remove Real Servers from the LineRate configuration
 as necessary. Upon startup, it will do some initialization tasks:

 --- SNS Processor Functionality --- runs on all LineRate processes ---
 * Ensure an SNS Listener Virtual IP exists on LineRate, if not, create it
 * Ensure an SNS Listener Virtual Server exists on LineRate, if not, create it
 * Listen only for "addInstance", "removeInstance", and "subscriptionConfirmation" SNS events

 --- AutoScaler Functionality --- runs on master process only ---
 * For each configured Virtual Server:
 - Ensure the Virtual Server exists on LineRate, if not, remove it from AutoScaler management
 - Ensure the configured Real Server Group (RSG) exists on LineRate, if not, create it
 - Determine what other RSGs are configured on LineRate;
 > (forced sync only) remove non-Amazon AutoScaler RSGs from the Virtual Server
 - Determine what Real Servers exist (individual RSs and RSG members)
 > delete Real Servers with the configured Amazon Real Server prefix that no longer exist
 > (forced sync only) remove Real Servers from the Virtual Server that do not have an Amazon RS prefix
 * Listen for addInstance and removeInstance notifications from SNS Listener:
 - On an addInstance notifications:
 > Create a new Real Server with the configured Amazon Real Server prefix and fetched IP information
 > (configured health monitor only) Attach the configured Health Monitor to the new Real Server
 - On a removeInstance notifications:
 > Delete the Real Server from LineRate
 * (manual refresh only) Periodically ensure LineRate Real Servers match Amazon instances

 Other considerations:
 * In this version of code, all real servers in a virtual server must use the same port.
 * Only one amazon Real Server Group can be configured and managed by this script. Others
 may exist on the Virtual Server (if forcedSync is not enabled), and will not be
 affected by the script.
 *
 CloudWatch Stats, add own monitoring stats (perhaps module on machines to report stuff)

 Dependencies:

 Initial Setup:
 scripting npm install "lros-autoscaler"

 scripting npm install "aws-sdk@2.1.7" ... modified version that works around unsupported LineRate Node functionality
 scripting npm install "async@0.9.0"
 scripting npm install "redis@0.12.0" ... avoids Redis Pub/Sub bug in the default system version 0.8.2

 Configuring the Amazon environment:
 1) Setup an SNS topic ... https://us-west-2.console.aws.amazon.com/sns/home
 2) Configure the SNS topic to publish to LineRate SNS Listener (ie. 'Create Subscription' via HTTP(S))
 3) Setup an IAM User, ensuring it has access to both SNS ... https://console.aws.amazon.com/iam/home
 4) Create and download the IAM User credentials; configure the AutoScaler script with these credentials

 NOTE: Having the SNS listener use HTTPS requires use of an Amazon trusted CA. See http://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.https.ca.html

 */
'use strict';
GLOBAL.Module = require('module');
(function() {
	var realRequire = GLOBAL.Module.prototype.require;
	GLOBAL.Module.prototype.require = function(path) {
		if(path == "domain") {
			return {};
		} else {
			return realRequire.call(this, path);
		}
	};
})();

var verbose = true; // Log messages to the console in a verbose manner
var util = require('util');
var url = require('url');
var lrsRest = require('lrs/managementRest');
var autoscaler, restClient, npmRetries = 0, packageName = 'lros-as-dev',
	AutoScaler = require(packageName + '/AutoScaler'),
	SNS = require(packageName + '/snsProcessor'),
	AWS = require(packageName + '/node_modules/aws-sdk');
var vsm = require('lrs/virtualServerModule');

var AS_config = {
	'timeout': 10, // seconds
	'redis_channel': "snsAction",
	'manualRefreshTimeout': 10, // 0 = don't manually refresh; positive integers = minutes
	'pendingInstanceTimeout': 5, // seconds
	'retryAttempts': 5,
	'retryDelay': 15, // seconds
	'restCredentials': {
		username: 'admin',
		password: 'cisco123'
	},
	// Virtual Server information listening for SNS Notifications
	'snsListener': {
		'vip_name': 'SNSListener',
		'vip_ip': '10.10.0.73',
		'vip_port': 8027
	},
	'virtualServers': {
		'LineRate-AutoScale': {
			'service_port': 80,
			'service_type': 'HTTP',
			'description': 'LineRate AutoScaler for LineRate-AutoScale',
			'rs_prefix': 'reuseStuffTemplate_LineRate-AutoScale_',
			'health_monitor': 'reuseStuffTemplate_LineRate-AutoScale_hm',
			'rs_group_name': 'reuseStuffTemplate_LineRate-AutoScale',
			'as_group_name': 'reuseStuffTemplate-WebServerGroup-JI1BRRMEESRY',
			'amazonIpType': 'private'
		}
	}
};

AWS.config = {
	"apiVersions": {
		sns: '2010-03-31',
		AutoScaling: '2011-01-01'
	},
	"region": "us-west-2",
	"sslEnabled": false		// SSL not currently supported
};

function masterProcessChanged() {
	// Let the script run only on one core
	if (process.isMaster() === true) {
		if (verbose) { console.log('(AutoScaler) Process ' + process.pid + ' is the master');}
		autoscaler = new AutoScaler(AS_config);
		SNS.SnsInit(AS_config.snsListener, AS_config.timeout, function initCb(err, result){
			if(err) {
				console.log("(AutoScalerInit) Error: " + err.message);
				return;
			}
			SNS.checkSnsSubscription();
		});
	}
}

function initAutoScaler() {
	var self = this;
	restClient = new lrsRest.Client();

	restClient.on('login', function doInitTasks() {
		process.on('masterChanged', masterProcessChanged);
		masterProcessChanged();

		// Start the SNS Listener and AutoScaler scripts once the SNS VIP is created and listening
		vsm.on('exist', AS_config.snsListener.vip_name, function vsExists(vs) {
			if (verbose) {
				console.log("(AutoScaler)  Monitoring '" + vs.id + "' at time " + Date.now());
			}
			vs.on('request', function handleRequest(servReq, servResp, cliReq){
				var processor = new SNS.Processor(servReq, servResp, cliReq, AS_config, function requestCallback(err, result) {
					if(err && verbose) {
						console.log("(AutoScaler) Error processing SNS Event: " + err);
					}
				});
			});
		});
	});

	var loginAttempts = 0;
	var loginReattemptTimeout = undefined;
	restClient.on('loginFailure', function(loginResponse, body) {
		if(loginResponse.statusCode == 302 &&
			url.parse(loginResponse.headers.Location, true).query.login == 1) {
			console.log('(AutoScalerInit) REST login failed (invalid password)');
		} else {
			if(++loginAttempts >= AS_config.retryAttempts) {
				console.log('(AutoScalerInit) REST login, unknown failure: ' + loginResponse + "; " + body);
				return;
			}
			// Wait and then reattempt the action
			loginReattemptTimeout = setTimeout(function retryLogin() {
				restClient.logIn(AS_config.restCredentials);
			}, 1000);
		}
	});
	if(!restClient.loggedIn) { restClient.logIn(AS_config.restCredentials); }
}

var lrosRestAction = function(method, rest_path, options, callback) {
	var self = this;
	var returned = false;
	var attempts = 0;
	var reattemptTimeout = undefined;

	if(!rest_path) {
		return callback("No REST path provided.", { rest_path: "" });
	}

	var timeout = setTimeout(function parallelTimeout(){
		if(timeout)
		{
			if(reattemptTimeout) {
				clearTimeout(reattemptTimeout);
				reattemptTimeout = undefined;
			}
			timeout = undefined;
			return callback("(AutoScaler) A call to the LROS REST API Timed Out");
		}
	}, AS_config.timeout * 1000);

	var performAction = function() {
		if(returned) { return; }
		switch(method) {
			case "get":
			case "GET":
				restClient.getJSON(rest_path, lrosRestCb);
				break;
			case "post":
			case "POST":
				restClient.postJSON(rest_path, options, lrosRestCb);
				break;
			case "put":
			case "PUT":
				restClient.putJSON(rest_path, options, lrosRestCb);
				break;
			case "delete":
			case "DELETE":
				restClient.deleteJSON(rest_path, lrosRestCb);
				break;
			default:
				returned = true;
				return callback("Unsupported REST method: " + method, { rest_path: rest_path });
		}
	};
	performAction();

	function lrosRestCb(response) {
		var data = '';
		if((response.statusCode != 200 && response.statusCode != 404) && !returned) {
			if(++attempts >= AS_config.retryAttempts) {
				returned = true;
				return callback("Max number of attempts to LROS REST API occurred.", { rest_path: rest_path });
			}
			// Wait and then reattempt the action
			reattemptTimeout = setTimeout(performAction.bind(self), 1000);
		}
		response.on('data', function processRestData(chunk) {
			data += chunk;
		});
		response.on('end', function processRestResponse() {
			var jsonData = {};
			try {
				if(data.length > 0) {
					jsonData = JSON.parse(data);
				}
			} catch(e) {
				if(!returned) {
					returned = true;
					return callback("Error parsing JSON REST response: " + e, { rest_path: rest_path });
				}
			}
			if(!returned) {
				returned = true;

				if(!timeout) { return; }
				if(reattemptTimeout) {
					clearTimeout(reattemptTimeout);
					reattemptTimeout = undefined;
				}
				clearTimeout(timeout);
				timeout = undefined;

				jsonData.rest_path = rest_path;
				return callback(null, jsonData);
			}
		});
	}
};

initAutoScaler();
//process.on('uncaughtException', function uncaughtException(error) { console.log("(AutoScaler) Uncaught Exception: " + error); });

