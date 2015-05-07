'use strict';

var https = require('https');
var url = require('url');
var redis = require('redis').createClient();
var async = require('async');
var util = require('util');
var vsm = require('lrs/virtualServerModule');

function SnsProcessor(servReq, servResp, cliReq, config, cb) {
	var self = this;
	this.config = config;
	this.snsHeaders = servReq.headers;
	this.snsData = '';
	var invalidRequest = false;

	// Add some security - only talk to AWS SNS for certain request types
	// ACLs should be configured in addition to this
	if(servReq.headers['User-Agent'] !== 'Amazon Simple Notification Service Agent') {
		if(verbose) { console.log("Bad Agent"); }
		invalidRequest = true;
		servResp.writeHead(400);
		servResp.end();
		return;
	}

	redis.on('error', function(err) {
		if(verbose) { console.log ("(AutoScalerInit) Redis error: " + err); }
	});

	servReq.on('error', function(err) { if(verbose) { console.log('(SNSListener) Error listening for AWS Events: %s', err.message); } });
	servResp.on('error', function(err) { if(verbose) { console.log('(SNSListener) Error responding to AWS Events: %s', err.message); } });
	cliReq.on('error', function(err) { console.log('(SNSListener) Unknown Error: %s', err.message); }); // This should never happen

	servReq.on('data', function snsListenerData(chunk){
		if(invalidRequest) { return; }
		if(Buffer.isBuffer(chunk)){
			self.snsData += chunk.toString();
		} else {
			self.snsData += chunk;
		}
	});
	servReq.on('end', function snsListenerEnd(){
		if(invalidRequest) { return; }
		try {
			self.snsData = JSON.parse(self.snsData);
		} catch (e) {
			if(verbose) { console.log("Error parsing body. Exiting."); }
			servResp.writeHead(503);
			servResp.end();
			return;
		}
		// Acknowledge receipt of message
		servResp.writeHead(200);
		servResp.end();

		// Perform notification action
		var snsHandlers = {
			// Allowed message types
			'SubscriptionConfirmation': self.confirmSubscription.bind(self),
			'Notification': self.handleNotification.bind(self)
		};
		if (typeof snsHandlers[self.snsHeaders['x-amz-sns-message-type']] !== 'function') {
			cb(new Error('Received invalid SNS Message.'), null);
		}
		return cb(null, snsHandlers[self.snsHeaders['x-amz-sns-message-type']]());
	});
}

SnsProcessor.prototype.confirmSubscription = function () {
	if(verbose) { console.log("Confirming Amazon AutoScale Subscription."); }
	https.get(this.snsData['SubscribeURL'], function(resp) {
		// Do nothing
		resp.on('data', function (chunk) {
			console.log(chunk.toString());
		})
	}).on('error', function(err) {
		if(verbose) {
			console.log("Error sending SNS Confirmation to AWS: " + err);
		}
	});
};

SnsProcessor.prototype.handleNotification = function () {
	var messageData = JSON.parse(this.snsData['Message']);
	var message = {};
	switch(messageData['Event']) {
		case 'autoscaling:EC2_INSTANCE_TERMINATE':
			message = {
				action: "removeInstance",
				as_group_name: messageData['AutoScalingGroupName'],
				instance: messageData['EC2InstanceId']
			};
		break;
		case 'autoscaling:EC2_INSTANCE_LAUNCH':
			message = {
				action: "addInstance",
				as_group_name: messageData['AutoScalingGroupName'],
				instance: messageData['EC2InstanceId']
			};
		break;
		default:
			if(verbose) { console.log("Got an unsupported SNS Notification: " + messageData['Event']); }
			return;
		break;
	}
	if(verbose) { console.log("(SNSListener) " + messageData['Description']); }

	// Alert the master process that an action needs to be taken
	try {
		var strMessage = JSON.stringify(message);
		redis.publish(this.config.redis_channel, strMessage);
	} catch (e) {
		if(verbose) {
			console.log("Error converting Redis JSON message to string");
		}
		return;
	}
};

function checkSnsVipVs(snsListener, timeout, callback) {
	// Check for SNS Listener VIP, create if necessary
	if(!vsm.find(snsListener.vip_name)) {
		var timeout = setTimeout (function createSnsVipVsTimeout() {
			if(timeout) {
				timeout = undefined;
			}
		}, timeout * 1000);
		var basePath = '/config/app/proxy/virtualIP/' + encodeURI (snsListener.vip_name);
		var basePath2 = '/config/app/proxy/virtualServer/' + encodeURI (snsListener.vip_name);
		async.parallel({
			// Create and configure the Virtual IP for the SNS Listener
			checkSnsVip: function(callback) {
				async.series({
						checkRsg: function (callback) {
							// Check if the configured Real Server Groups exist, update or create them if needed
							lrosRestAction('PUT', basePath,
							{
								data: encodeURI (snsListener.vip_name),
								type: "string",
								default: false
							}, callback);
						},
						setIp: function (callback) {
						// Set the VIP IP address
							lrosRestAction ('PUT', basePath + '/ipAddress',
							{
								data: {
									family: "af-inet",
									addr: snsListener.vip_ip,
									port: snsListener.vip_port
								},
								type: "socket-addr",
								default: false
							}, callback);
						},
						setSvcType: function (callback) {
							// Set VIP service Type
							lrosRestAction ('PUT', basePath + '/serviceType',
							{
								data: 1,
								type: "uint32",
								default: false
							}, callback);
						},
						setAdminStatus: function (callback) {
							// Set admin-status online
							lrosRestAction ('PUT', basePath + '/adminStatus',
							{
								type: "uint32",
								data: 1, // 0 = offline, 1 = online
								default: false
							}, callback);
						}
					}, function checkSnsVipCb(err, result) {
						if(err) {
							return callback(err);
						}
						if(!timeout) { return callback("Check SNS VIP timed out."); }
						if(verbose) {
							console.log ("(AutoScalerInit) Successful creation of SNS Listener Virtual IP: " + snsListener.vip_name);
						}
						return callback(null, result);
					}
				);
			},
			checkSnsVs: function(callback) {
				async.series({
						createVs: function (callback) {
							// Create and configure the Virtual Server for the SNS Listener
							lrosRestAction ('PUT', basePath2,
							{
								data: encodeURI (snsListener.vip_name),
								type: "string",
								default: false
							}, callback);
						},
						attachVip: function (callback) {
							// Attach the VIP
							lrosRestAction ('PUT', basePath2 + '/virtualIP/' + encodeURI (snsListener.vip_name),
							{
								data: encodeURI (snsListener.vip_name),
								type: "string",
								default: false
							}, callback);
						},
						setDefault: function (callback) {
							// Set VS as default (accept all incoming requests)
							lrosRestAction ('PUT', basePath2 + '/virtualIP/' + encodeURI (snsListener.vip_name) + '/default',
							{
								data: 1,
								type: "uint32",
								default: false
							}, callback);
						},
						setSvcType: function (callback) {
							// Set VS service Type
							lrosRestAction ('PUT', basePath2 + '/serviceType',
								{
									data: 1,
									type: "uint32",
									default: false
								}, callback);
						},
						setAdminStatus: function (callback) {
							// Set admin-status online
							lrosRestAction ('PUT', basePath + '/adminStatus',
							{
								type: "uint32",
								data: 1, // 0 = offline, 1 = online
								default: false
							}, callback);
						}
					}, function checkSnsVsCb(err, result) {
						if(err) {
							return callback(err);
						}
						if(!timeout) { return callback("Check SNS VS timed out."); }
						if(verbose) {
							console.log ("(AutoScalerInit) Successful creation of SNS Listener Virtual Server: " + snsListener.vip_name);
						}
						return callback(null, result);
					}
				);
			}
		}, function createSnsVSCb(err, data) {
				if(err) {
					return callback(err, false);
				}
				if(!timeout) { return callback("Check SNS on LROS timed out."); }
				clearTimeout (timeout);
				timeout = undefined;
				callback (null, true);
			}
		);
	}
	return (null, true);
}

function checkSnsSubscription(){
	var awsSns = new AWS.SNS();
	http.get("http://169.254.169.254/latest/meta-data/public-ipv4", function(resp) {
		// Do nothing
		resp.on('data', function (chunk) {
			//console.log(chunk.toString());
		})
	}).on('error', function(err) {
		if(verbose) {
			console.log("Error getting instance's Public IP: " + err);
		}
	});
	awsSns.listSubscriptions({}, function (err, data) {
		if (err) {
			console.log("SNS Subscription Error: ", err, err.stack);
		} else {
			data.Subscriptions.forEach(function (subscription){
				//if(subscription.Endpoint.indexOf(endpoint) >= 0 && subscription.SubscriptionArn === "PendingConfirmation") {
				//
				if(subscription.SubscriptionArn === "PendingConfirmation"){
					// Endpoint pending; resubscribe
					awsSns.subscribe({
						Protocol: subscription.Protocol,
						TopicArn: subscription.TopicArn,
						Endpoint: subscription.Endpoint
					}, function(err, data){
						if (err) {
							// Do nothing, process next item
							return;
						}
						if(verbose) {
							console.log("(AutoScalerInit) Sent SNS Subscribe message for '%s'", subscription.Endpoint);
						}
					});
				}
			});
		}
	});
}
module.exports.Processor = SnsProcessor;
module.exports.SnsInit = checkSnsVipVs;
module.exports.checkSnsSubscription = checkSnsSubscription;