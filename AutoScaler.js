'use strict';
var vsm = require('lrs/virtualServerModule');
var lrsRest = require('lrs/managementRest');
var redis = require('redis').createClient();
var url = require('url');
var util = require('util');
var async = require('async');

GLOBAL.http = require('http');
(function() {
	var realSetTimeout = GLOBAL.http.ClientRequest.prototype.setTimeout;
	GLOBAL.http.ClientRequest.prototype.setTimeout = function() {
		// Do nothing
	};
})();

function AutoScaler(conf)
{
	this.config = conf || {};
	this.retries = {};
	// Setup AWS and LROS-REST
	if(process.isMaster() === true) // Let the script run only on one core
	{
		var self = this;
		this.aws_as = new AWS.AutoScaling();
		this.aws_ec2 = new AWS.EC2();
		this.restClient = new lrsRest.Client();

		this.restClient.on('login', function fetchBaselineInfo() {
			var servers = Object.keys(self.config.virtualServers);
			var tasks = servers.length || 0;
			servers.forEach(function(server){
				if(self.config.virtualServers[server].service_type &&
					self.config.virtualServers[server].service_type.toLowerCase() == "tcp"){
					// Set to TCP
					self.config.virtualServers[server].service_type = 2;
				} else {
					// Default to HTTP
					self.config.virtualServers[server].service_type = 1;
				}
				lrosRestAction("GET", "/status/app/proxy/virtualServer/" + server, {}, function checkVsExistsCb(err, result){
					var server = result.rest_path.split("/").pop();
					if(result.httpResponseCode == 200) {
						if(verbose) { console.log("(AutoScaler) Monitoring Virtual Server: " + server); }
						// Configure instance data structure, if it doesn't already exist
						if(!self.config.virtualServers[server].amazon){
							self.config.virtualServers[server].amazon = {};
						}
						if(!self.config.virtualServers[server].linerate) {
							self.config.virtualServers[server].linerate = {};
						}
					} else {
						console.log("(AutoScaler) WARNING: Virtual Server '%s' doesn't exist.", server);
						//delete self.config.virtualServers[server];
					}
					if(--tasks <= 0){
						if(!self.initialSyncRetries) { self.initialSyncRetries = 0; }
						var syncInstancesCb = function (err, result) {
							if(err && ++self.initialSyncRetries <= self.config.retryAttempts){
								setTimeout(self.syncInstances.bind(self, syncInstancesCb), 1000);
							}
						};
						self.syncInstances(syncInstancesCb);
					}
				});
			});
		});

		var loginAttempts = 0;
		var loginReattemptTimeout = undefined;

		this.restClient.on('loginFailure', function(loginResponse, body) {
			if(loginResponse.statusCode == 302 &&
				url.parse(loginResponse.headers.Location, true).query.login == 1) {
				console.log('(AutoScaler) REST login failed (invalid password)');
			} else {
				if(++loginAttempts >= self.config.retryAttempts) {
					console.log('(AutoScaler) REST login, unknown failure: ' + loginResponse + "; " + body);
					return;
				}
				// Wait and then reattempt the action
				loginReattemptTimeout = setTimeout(function retryLogin() {
					self.restClient.logIn(self.config.restCredentials);
				}, 1000);
			}
		});
		if(!this.restClient.loggedIn) { this.restClient.logIn(this.config.restCredentials) }

		redis.on('error', function(err) {
			console.log("(AutoScaler) Redis error: " + err);
		});
		redis.subscribe(self.config.redis_channel, function(channel, count) {
			// Do nothing
		});
		redis.on('message', function(channel, message) {
			if(channel !== self.config.redis_channel) { return; }
			try {
				var opts = JSON.parse(message);
			} catch(e) {
				console.log("(AutoScaler) Error parsing Redis JSON: " + e);
				return;
			}
			//Find LR VS associated with the Amazon Group
			var lrVSes = Object.keys(self.config.virtualServers);
			var lrvs;
			for(var i = 0; i < lrVSes.length; i++){
				if(self.config.virtualServers[lrVSes[i]].as_group_name === opts.as_group_name){
					lrvs = lrVSes[i];
					break;
				}
			}
			var currentInstances = Object.keys(self.config.virtualServers[lrvs].amazon) || [];
			switch(opts.action){
				case 'addInstance':
					if(currentInstances.indexOf(opts.instance) === -1) {
						self.handleNewInstance (lrvs, opts.instance, function addInstCb(err, result){
							// Do nothing
						});
					}
					break;
				case 'removeInstance':
					self.deleteRealServer(lrvs, self.config.virtualServers[lrvs].rs_prefix + opts.instance, function removeRsCallerCb(err, result){
						if(verbose && result.message && result.message.indexOf("Path not found") >= 0) {
							console.log("(AutoScaler) Instance '%s' cannot be removed (Not Found)",
							self.config.virtualServers[result.vs].rs_prefix + opts.instance)
						}
						if(err) {
							if(verbose) {
								console.log("Error removing Real Server: " + err);
							}
							return;
						}
						if(self.config.virtualServers[result.vs].linerate[result.rs]){
							delete self.config.virtualServers[result.vs].linerate[result.rs];
						}
						var amazon_instance = result.rs.replace(self.config.virtualServers[result.vs].rs_prefix,"");
						if(self.config.virtualServers[result.vs].amazon[amazon_instance]) {
							delete self.config.virtualServers[result.vs].amazon[amazon_instance];
						}
					});
					break;
			}
		});
	} else {
		if(verbose) { console.log("(AutoScaler) Skipped for %s", process.pid); }
	}
}

AutoScaler.prototype.handleNewInstance = function(lrvs, instance, callback) {
	var self = this;
	var matrix = {};
	matrix[lrvs] = [ instance ];
	self.getEc2IPs(matrix, function newInstEc2IpCb(err, result) {
		if (err) {
			if(!self.retries[instance]) {
				self.retries[instance] = 0;
			}
			self.retries[instance]++;
			if(self.retries[instance] > self.config.retryAttempts) {
				console.log("Error adding instance '%s': " + err, instance);
				delete self.retries[instance];
				return callback(err);
			}
			setTimeout(self.handleNewInstance.bind(self, lrvs, instance, callback),
				self.config.retryDelay * 1000);
			return;
		}
		self.createRealServer(lrvs, instance, function addRsCallerCb(err, result) {
			if(err) {
				if(!self.retries[result.instance]) {
					self.retries[result.instance] = 0;
				}
				self.retries[result.instance]++;
				if(self.retries[result.instance] > self.config.retryAttempts) {
					console.log("Error adding instance '%s': " + err, result.instance);
					delete self.retries[result.instance];
					return callback(err);
				}
				setTimeout(self.handleNewInstance.bind(self, result.vs, result.instance, callback),
					self.config.retryDelay * 1000);
			} else if(verbose) {
				console.log("Instance '%s' added successfully.", result.instance);
			}
			if(self.retries[result.instance]) {
				delete self.retries[result.instance];
			}
			return callback(null, result);
		});
	})
}

AutoScaler.prototype.parallel = function(tasks, callback) {
	var timeout = setTimeout(function parallelTimeout() {
		if(timeout)
		{
			timeout = undefined;
			return callback("(AutoScaler) A function in async.parallel Timed Out");
		}
	}, this.config.timeout * 1000);

	async.parallel(tasks, function(err, result){
		if(!timeout) { return; }
		clearTimeout(timeout);
		timeout = undefined;
		return callback(err, result);
	});
};

AutoScaler.prototype.series = function(tasks, callback) {
	var timeout = setTimeout(function seriesTimeout(){
		if(timeout)
		{
			timeout = undefined;
			return callback("(AutoScaler) A function in async.series Timed Out");
		}
	}, this.config.timeout * 1000);

	async.series(tasks, function(err, result) {
		if(!timeout) { return; }
		clearTimeout(timeout);
		timeout = undefined;
		return callback(err, result);
	});
};

AutoScaler.prototype.syncInstances = function(finalCallback) {
	var self = this;
	if(self.syncingInstances) { return; }
	if(!Object.keys(self.config.virtualServers).length) {
		return finalCallback("No valid Virtual Servers configured");
	}
	self.syncingInstances = true;
	if(!self.syncRetries) { self.syncRetries = 0; }
	var syncInstancesCb = function (err, result) {
		if(err && ++self.syncRetries <= self.config.retryAttempts){
			self.instanceStartupTimer = setTimeout(self.syncInstances.bind(self, syncInstancesCb),
				self.config.retryDelay * 1000);
		} else {
			if(err){
				console.log("Error adding instance.");
			}
			if(verbose) { console.log("Instances added successfully: " + util.inspect(results)); }
		}
		self.syncRetries = undefined;
	};
	if(verbose) { console.log("(AutoScaler) Syncing LineRate real servers to AWS instances.")}
	this.parallel({
			// Discover all instances in AWS
			aws_instances: function(callback) {
				async.waterfall([
						self.getAwsInstances.bind(self, Object.keys(self.config.virtualServers)),
						self.getEc2IPs.bind(self)
					],
					function(err, results) {
						if(err) {
							return callback(err);
						}
						return callback(null, results);
					});
			},
			// Discover all instances configured on LROS
			lros_instances: function(callback) {
				async.series([
						// Check if the configured Real Server Groups exist, update or create them if needed
						self.checkServerGroup.bind(self, Object.keys(self.config.virtualServers)),
						self.getLrosInstances.bind(self, Object.keys(self.config.virtualServers))
					],
					function(err, results) {
						if(err) {
							return callback(err);
						}
						return callback(null, results);
					});
			},
			// Check if the configured Health Monitors exist, create a basic one if not found
			lros_hmb_exists: self.checkHealthMonitor.bind(self, Object.keys(self.config.virtualServers)),

			// Check if a Real Server Base exists, if not create one if not found
			lros_rsb_exists: self.checkRealServerBase.bind(self, Object.keys(self.config.virtualServers))
		},
		function getSystemStateCallback(err, results) {
			if(err) {
				self.syncingInstances = false;
				console.log(err);
				return finalCallback(err);
			}
			var success = [];
			var failure = [];
			var virtual_servers = Object.keys(results.aws_instances);
			var tasks = virtual_servers.length;
			if(verbose) {
				if(results.lros_hmb_exists.failure.length > 0) {
					console.log("(AutoScalerInit) Health Monitor Check Failures:");
					results.lros_hmb_exists.failure.forEach(function(item) {
						console.log(item);
					});
				}
				if(results.lros_hmb_exists.success.length > 0) {
					console.log("(AutoScalerInit) Health Monitor Check Successes:");
					results.lros_hmb_exists.success.forEach(function(item) {
						console.log(item);
					});
				}
			}
			virtual_servers.forEach(function(vs){
				var lros_instances = Object.keys(self.config.virtualServers[vs].linerate);
				var fetched_instances = results['aws_instances'][vs];
				var toAdd = [];
				var toRemove = lros_instances;
				var toDelete = [];
				// Add/update valid Real Servers, delete if not present
				fetched_instances.forEach(function(instance) {
					var instance_name = self.config.virtualServers[vs].rs_prefix + instance;
					// Refresh LROS RS parameters with current fetch information
					toAdd.push(instance);
					// This is a valid RS, do not remove
					var position = toRemove.indexOf(instance_name);
					if(position >= 0) {
						toRemove.splice(position, 1);
					}
				});
				// If an existing Real Server has the rs_prefix but isn't present in the current instance list, delete it
				toRemove.forEach(function(rServer){
					if(rServer.indexOf(self.config.virtualServers[vs].rs_prefix) >= 0) {
						toDelete.push(rServer);
					}
				});

				// Delete amazon-prefixed Real Servers that no longer exist but are still lingering on LineRate
				(function(virtual_server, toDelete) {
					toDelete.forEach(function(server) {
						self.deleteRealServer(virtual_server, server, function removeRsCb(err, results) {
							if(err) {
								failure.push("Issue deleting Real Server '" + results.rs +
								"' on Virtual Server '" + results.vs + "': " + results.rest);
								return;
							}
							if(self.config.virtualServers[results.vs].linerate[results.rs]){
								delete self.config.virtualServers[results.vs].linerate[results.rs];
							}
							var amazon_instance = results.rs.replace(self.config.virtualServers[results.vs].rs_prefix,"");
							if(self.config.virtualServers[results.vs].amazon[amazon_instance]) {
								delete self.config.virtualServers[results.vs].amazon[amazon_instance];
							}
							success.push("Removed Real Server '" + results.rs +
							"' on Virtual Server '" + results.vs + "'");
						});
					});
				})(vs, toDelete);

				// Add any AWS instances found that don't exist in our VS
				(function(virtual_server, toAdd) {
					toAdd.forEach(function(server) {
						self.createRealServer(virtual_server, server, function addServerCb(err, results) {
							if(err) {
								if(err.indexOf("No IP") >= 0) {
									if(!self.instanceStartupTimer) {
										if(!self.instanceStartupRetries) { self.instanceStartupRetries = 0; }
										var syncInstancesCb = function (err, result) {
											if(err && ++self.instanceStartupRetries <= self.config.retryAttempts){
												self.instanceStartupTimer = setTimeout(self.syncInstances.bind(self, syncInstancesCb),
													self.config.retryDelay * 1000);
											} else {
												if(err){
													console.log("Error adding instance.");
												}
												if(verbose) { console.log("Instances added successfully: " + util.inspect(results)); }
											}
											self.instanceStartupRetries = undefined;
										};
										self.instanceStartupTimer = setTimeout (self.syncInstances.bind (self, syncInstancesCb),
											self.config.retryDelay * 1000);
									} else {
										failure.push ("Issue adding Real Server '" + results.rs +
										"' on Virtual Server '" + results.vs + "': " + err);
									}
									return;
								}
							}
							success.push("Added Real Server '" + results.rs +
							"' on Virtual Server '" + results.vs + "'");
						});
					});
				})(vs, toAdd);

				if(--tasks <= 0) {
					self.syncingInstances = false;
					process.nextTick(doCallback.bind(self, success, failure));
				}
			});
			function doCallback(success, failure) {
				success.forEach(function(item) { if(verbose) { console.log(item); } });
				failure.forEach(function(item) { if(verbose) { console.log(item); } });
				return finalCallback(null, true);
			}
		}
	)
};

AutoScaler.prototype.getAwsInstances = function(vs_names, callback) {
	var self = this;
	var discoveredInstances = {};
	var groups = [];
	var group_map = {};
	vs_names.forEach(function(vs){
		if(self.config.virtualServers[vs].as_group_name.length > 0) {
			groups.push(self.config.virtualServers[vs].as_group_name);
			group_map[self.config.virtualServers[vs].as_group_name] = vs;
			discoveredInstances[vs] = [];
		} else {
			if(verbose) {
				console.log("(AutoScaler) No Amazon AutoScaler Group Name for '%s'", vs);
			}
		}
	});
	if(groups.length == 0) {
		// No groups to process
		return callback(null, null);
	}
	self.aws_as.describeAutoScalingGroups({ AutoScalingGroupNames: groups }, function(err, data) {
		if(err) {
			return callback("AWS getRunning Instances error: " + err);
		}
		data.AutoScalingGroups.forEach(function(group){
			group['Instances'].forEach(function(instance){
				if(verbose) {
					console.log("(AutoScaler) Found %s instance: %s for '%s'",
						instance['LifecycleState'],
						instance['InstanceId'],
						group['AutoScalingGroupName']);
				}
				var instance_id = instance['InstanceId'];
				var vs = group_map[group['AutoScalingGroupName']];
				var allowedStates = ["Pending", "Pending:Wait", "Pending:Proceed", "InService", "EnteringStandby", "Standby"];
				// Ignore these lifecycle states: "Quarantined", "Terminating", "Terminating:Wait", "Terminating:Proceed", "Terminated", "Detaching", "Detached"
				if(allowedStates.indexOf(instance['LifecycleState']) >= 0){
					discoveredInstances[vs].push(instance_id);
				}
			});
		});
		return callback(null, discoveredInstances);
	});
};

AutoScaler.prototype.getEc2IPs = function(instance_matrix, callback) {
	/*
		instance_matrix = {
			'vs1': ['inst1', ... 'instN'],
			...
			'vsN': ['inst1', ... 'instN'],
		}
	*/
	var self = this;
	var instances = [];
	var processedInstances = [];
	var vs_names = Object.keys(instance_matrix);
	if(vs_names.length == 0) {
		if(verbose) {
			console.log("(AutoScaler) No Virtual Servers specified to getEc2IPs");
		}
		return callback(null, processedInstances);
	}
	async.each(vs_names, function(vs, each_vs_cb) {
		instances = instance_matrix[vs];
		processedInstances[vs] = [];
		if(instances.length == 0) {
			if(verbose) {
				console.log("(AutoScaler) No Amazon Instances to update for '%s'", vs);
			}
			// No items to process, continue to next item
			return each_vs_cb(null);
		}
		self.aws_ec2.describeInstances({
			InstanceIds: instances,
			Filters: [{
				Name: 'instance-state-name',
				Values: ['pending', 'running']
			}]
		}, function(err, data) {
			if(err) {
				if(verbose) {
					console.log("AWS describe Instances error: " + err);
				}
				// Error, continue to next item
				return each_vs_cb(null);
			}
			async.each(data.Reservations, function(amazon_item, amazon_reservation_cb) {
				async.each(amazon_item.Instances, function(instance, amazon_instance_cb) {
					if(self.config.virtualServers[vs].amazonIpType == "public") {
						self.config.virtualServers[vs].amazon[instance.InstanceId] = instance.PublicIpAddress;
					} else {
						self.config.virtualServers[vs].amazon[instance.InstanceId] = instance.PrivateIpAddress;
					}
					processedInstances[vs].push(instance.InstanceId);
					return amazon_instance_cb(null);
				}, function(err) {
					return amazon_reservation_cb(err);
				});
			}, function(err) {
				return each_vs_cb(err);
			});
		});
	}, function(err) {
		return callback(err, processedInstances);
	});
};

AutoScaler.prototype.getLrosInstances = function(vs_names, callback) {
	var self = this;
	var discoveredInstances = [];
	var errors = [];
	var vstasks = vs_names.length;
	vs_names.forEach(function(vs){
		self.parallel({
			rsGroupMembers: function(cb) {
				// Find all RS Groups
				self.getServerGroups([vs],
					function fetchRSGCb(err, result) {
						var lr_vs = Object.keys(result)[0];
						if(!discoveredInstances[lr_vs]) {
							discoveredInstances[lr_vs] = [];
						}
						if(err) {
							errors.push("Error fetching Real Server Groups attached to VS " + lr_vs + ": " + err);
							return cb(err);
						}
						result[lr_vs].forEach(function(group) {
							if(!self.config.virtualServers[lr_vs].nonAmazonGroups) {
								self.config.virtualServers[lr_vs].nonAmazonGroups = {};
							}
							if(group.indexOf(self.config.virtualServers[lr_vs].rs_group_name) == -1) {
								// Group is non-Amazon related, track it for possible removal
								self.config.virtualServers[lr_vs].nonAmazonGroups[group] = [];
							}
						});
						// Find all members of each RS Group
						async.each(result[lr_vs], function getRsgMembers(group, rsgCb) {
								lrosRestAction('GET', '/status/app/proxy/realServerGroup/' + encodeURI(group) + '/members?op=list', {},
									function(err, result) {
										if(err || result.httpResponseCode != 200) {
											errors.push(err + " - " + result.message);
											// Skip this item, but continue processing others
											return rsgCb(null);
										}
										var members = [];
										var group = result['requestPath'].substr(34).split("/").shift();
										var numChildren = (typeof result[result['requestPath']].numChildren === 'number' ? result[result['requestPath']].numChildren : 0);
										var children = (typeof result[result['requestPath']].children === 'object' ? result[result['requestPath']].children : '');
										if(numChildren >= 1) {
											var member_names = Object.keys(children);
											var tasks = member_names.length;
											member_names.forEach(function(member){
												if(children[member].numChildren == 0) {
													member = member.split("/").pop();
													if(self.config.virtualServers[lr_vs].nonAmazonGroups[group]) {
														self.config.virtualServers[lr_vs].nonAmazonGroups[group].push(member);
													}
													members.push(member);
													self.getRsIp(member, function updateRsIp(err, result) {
														if(err) {
															errors.push(err);
															// Skip this item, but continue processing others
															return;
														}
														discoveredInstances[lr_vs].push(result.rs);
														self.config.virtualServers[lr_vs].linerate[result.rs] = {
															ip: result.ip,
															port: result.port
														};
														if(--tasks <= 0) {
															// Item processing complete
															return rsgCb(null, null);
														}
													});
												} else {
													// Recursive or non-existent children found
													// This is not currently supported
													errors.push("Unsupported children format for Real Server Group member '" + member_names[m] + "'");
													// Skip this item, but continue processing others
													return rsgCb(null);
												}
											});
										} else {
											// No items to process
											return rsgCb(null);
										}
									});
							}, function getRsgMembersErrorCb(err) {
								return cb(err, null);
							}
						);
					}
				);
			},
			individualMembers: function(cb) {
				// Find all individual instances(i.e. not part of a Real Server Group)
				lrosRestAction('GET', '/status/app/proxy/virtualServer/' + vs + '/realServer?op=list', {},
					function getLrosReals(err, data) {
						if(!discoveredInstances[lr_vs]) {
							discoveredInstances[lr_vs] = [];
						}
						if(data.httpResponseCode != 200 && data.httpResponseCode != 404) {
							errors.push("Bad Response");
							// Skip this item, but continue processing others
							return cb(null);
						}
						if(data[data['requestPath']].numChildren == 0) {
							// No members
							return cb(null, []);
						}
						var lr_children = data[data['requestPath']]['children'];
						var lr_vs = data['requestPath'].substr(32).split("/").shift();
						var lr_instances = Object.keys(lr_children);
						var tasks = lr_instances.length;
						if(lr_instances.length > 0) {
							lr_instances.forEach(function(lr_instance){
								var rs_name = lr_instance.split("/").pop();
								self.getRsIp(rs_name, function updateRsIp(err, result) {
									if(err) {
										errors.push(err);
										return;
									}
									discoveredInstances[lr_vs].push(result.rs);
									self.config.virtualServers[lr_vs].linerate[result.rs] = {
										ip: result.ip,
										port: result.port
									};
									if(--tasks <= 0) {
										// Item processing complete
										return cb(null, null);
									}
								});
							});
						} else {
							// No members found
							return cb(null, []);
						}
					}
				);
			}
		}, function getInstancesParallelCb(err, result) {
			// Do nothing
			if(--vstasks <= 0) {
				// For loop done, send callback
				if(verbose) {
					errors.forEach (function (element) {
						console.log (element);
					});
				}
				return callback (null, discoveredInstances);
			}
		});
	});
};

AutoScaler.prototype.getRsIp = function(rs_name, callback) {
	// Get Port for the RS
	lrosRestAction('GET','/status/app/proxy/realServer/' + rs_name + '/ipAddress', {},
		function processRSRestResponse(err, data) {
			if(data.httpResponseCode != 200){
				return callback("Error in LROS REST GET: " + err);
			}
			if(data[data['requestPath']].numChildren != 0 || Object.keys(data).length > 1){
				return callback(null,
					{
						rs: rs_name,
						ip: data[data['requestPath']].data.addr,
						port: data[data['requestPath']].data.port
					});
			} else {
				// Unsupported number of nodes returned
				return callback("Unsupported number of children in LROS RS Port fetch: " + err);
			}
		}
	);
};

AutoScaler.prototype.getServerGroups = function(vs_names, callback) {
	var self = this;

	var results = {};
	var tasks = vs_names.length;
	vs_names.forEach(function(vs){
		results[vs] = [];
		lrosRestAction('GET','/config/app/proxy/virtualServer/' + vs +
		'/realServerGroup?op=list', {}, function restRsGroupsCb(err, data) {
			var lr_vs = data['requestPath'].substr(32).split("/").shift();
			if(data.httpResponseCode != 200) {
				if(verbose) {
					if(data.httpResponseCode == 404) {
						// Group not found
						console.log("Error getting Real Server Group for '%s'", lr_vs);
					} else {
						console.log("Server Group not found for Virtual Server '%s'", lr_vs);
					}
				}
				if(!results[lr_vs]) {
					// Set no group for VS, continue processing
					results[lr_vs] = [];
				}
				return;
			}
			var numChildren = data[data['requestPath']].numChildren;
			var children = data[data['requestPath']].children;

			if(numChildren >= 1) {
				var group_names = Object.keys(children);
				group_names.forEach(function(group){
					if(children[group].numChildren == 1) {
						group = group.split("/").pop();
						results[lr_vs].push(group);
					} else {
						// Recursive or non-existent children found
						// This is not currently supported
						if(verbose) {
							console.log("Unsupported children format for Real Server Group '" + lr_vs + "'")
						}
					}
				});
			}
			if(--tasks <= 0) {
				// For loop done, send callback
				return callback(null, results);
			}
		});
	});
};

AutoScaler.prototype.checkHealthMonitor = function(vs_names, callback) {
	var self = this;
	var success = [];
	var failure = [];
	async.each(vs_names, function(virtual_server, callback) {
		if(!self.config.virtualServers[virtual_server].health_monitor ||
			self.config.virtualServers[virtual_server].health_monitor.length < 1) {
			if(verbose){
				console.log("(AutoScaler) No health monitor configured for '" + virtual_server + "'");
			}
			failure.push([virtual_server, "No HM Configured"]);
			return callback(null, false);
		}
		// Does a Health Monitor exist on this VS? If not create one
		lrosRestAction('GET','/status/app/health/monitor/' +
			encodeURI(self.config.virtualServers[virtual_server]['health_monitor']) + '?op=list', {},
			function lrosHmExistsCb(err, data) {
				if(data.httpResponseCode != 200 || data.httpResponseCode != 404) {
					if(err) {
						failure.push([virtual_server, err]);
						return callback(null, false);
					}
				}
				// No valid health monitor found, alert this and do not configure it
				if(data.httpResponseCode == 404) {
					console.log("(AutoScaler) WARNING: Configured health monitor '%s' not found for VS '%s'. Creating one.",
						self.config.virtualServers[virtual_server]['health_monitor'], virtual_server);
					// Create basic Health Monitor
					self.createHealthMonitor(virtual_server, self.config.virtualServers[virtual_server].rs_prefix + "hm",
						function cHMCb(err, result){
							if(err) {
								failure.push([virtual_server, "HM Creation Error: " + err]);
								return callback (null, false);
							}
							success.push([virtual_server, "HM Exists"]);
							return callback(null, true);
						})
				} else {
					success.push([virtual_server, "HM Exists"]);
					return callback(null, true);
				}
			}
		);
	}, function afterEachVsCb(err, result) {
		return callback(err, {failure: failure, success: success});
	});
};

AutoScaler.prototype.createHealthMonitor = function(virtual_server, hm_name, callback){
	var self = this;
	var basePath = '/config/app/health/monitor/' + encodeURI(hm_name);
	this.series({
			create: function (callback){
				// Create RS(or ensure it exists)
				lrosRestAction('PUT', basePath,
					{
						data: encodeURI (hm_name),
						type: "string",
						default: false
					}, callback);
			},
			svcType: function (callback) {
				// Set/update RS service Type
				lrosRestAction('PUT', basePath + '/type',
					{
						data: self.config.virtualServers[virtual_server].service_type, // 0 = disabled (default), 1 = http, 2 = tcp
						type: "uint32",
						default: false
					}, callback);
			}
		}, function cHmCb(err, result) {
			if(err) {
				return callback("Error creating Health Monitor '" + hm_name + "': " + err,
					{ vs: virtual_server, hm: hm_name });
			}
			return callback (null, { vs: virtual_server, hm: hm_name });
		}
	);
};

AutoScaler.prototype.checkRealServerBase = function(vs_names, callback) {
	var self = this;
	var success = [];
	var failure = [];
	async.each(vs_names, function(virtual_server, callback) {
		// Does a Real Server Base exist for this VS? If not create one
		var rsb_name = self.config.virtualServers[virtual_server].rs_prefix + "base";
		lrosRestAction('GET','/status/app/proxy/realServerBase/' + encodeURI(rsb_name) + '?op=list', {},
			function lrosRsbExistsCb(err, data) {
				if(data.httpResponseCode != 200 || data.httpResponseCode != 404) {
					if(err) {
						failure.push(virtual_server);
						return callback(null, false);
					}
				}
				// No valid Real Server Base found
				if(data.httpResponseCode == 404) {
					console.log("(AutoScaler) WARNING: Real Server Base '%s' not found for VS '%s'. Creating one.",
						self.config.virtualServers[virtual_server]['health_monitor'], virtual_server);
					// Create basic Health Monitor
					self.createRealServerBase(virtual_server, function cHmCb(err, result){
							if(err) {
								failure.push ([virtual_server, "RSB Creation Error"]);
								return callback(null, false);
							}
							success.push ([virtual_server, "RSB Created"]);
							return callback(null, true);
						}
					);
				} else {
					success.push ([virtual_server, "RSB Exists"]);
					return callback(null, true);
				}
			}
		);

	}, function afterEachVsCb(err, result) {
		return callback(err, { success: success, failure: failure } );
	});
};

AutoScaler.prototype.createRealServerBase = function(virtual_server, callback){
	var self = this;
	var base_name = this.config.virtualServers[virtual_server].rs_prefix + "base";
	var basePath = '/config/app/proxy/realServerBase/' + encodeURI(base_name);
	this.series({
			create: function (callback) {
				// Create RS(or ensure it exists)
				lrosRestAction ('PUT', basePath,
					{
						data: encodeURI (base_name),
						type: "string",
						default: false
					}, callback);
			},
			svcType: function (callback) {
				lrosRestAction ('PUT', basePath + '/serviceType',
					{
						data: self.config.virtualServers[virtual_server].service_type || 1, // 0 = http(default), 1 = http(user configured), 2 = tcp
						type: "uint32",
						default: false
					}, callback);
			},
			adminStatus: function (callback) {
				// Set admin-status online
				console.log("Setting admin status");
				lrosRestAction ('PUT', basePath + '/adminStatus',
					{
						type: "uint32",
						data: 1, // 0 = offline, 1 = online
						default: false
					}, callback);
			}
		}, function cRsbCb(err, result) {
			if(err) {
				return callback("Error creating Real Server Base '" + base_name + "': " + err,
					{ vs: virtual_server, rsb: base_name } );
			}
			return callback(null, { vs: virtual_server, rsb: base_name });
		}
	);
};

AutoScaler.prototype.checkServerGroup = function(vs_names, callback) {
	var self = this;
	var success = [];
	var failure = [];
	var totalSuccess = [];
	var totalFailure = [];
	async.each(vs_names, function(virtual_server, callback) {
		self.parallel({
			groupExists: function groupExists(callback) {
				// Does Server Group exist? If not create
				var cbCalled = false;
				lrosRestAction('GET','/status/app/proxy/realServerGroup/' +
					encodeURI(self.config.virtualServers[virtual_server]['rs_group_name']) + '?op=list&level=recurse', {},
					function lrosSgExistsCb(err, data) {
						if(data.httpResponseCode != 200 || data.httpResponseCode != 404) {
							if(err) {
								failure.push(virtual_server);
								return callback(err);
							}
						}
						// If Server Group doesn't exist, create it
						if(data.httpResponseCode == 404) {
							self.createServerGroup(self.config.virtualServers[virtual_server]['rs_group_name'],
								function setServerGroupCb(err, result){
									if(err) {
										failure.push(virtual_server);
										return callback(err);
									}
									if(verbose) { console.log("(AutoScaler) Created Real Server Group: " + self.config.virtualServers[virtual_server]['rs_group_name']); }
									checkExpression();
								}
							);
						} else {
							checkExpression();
						}
						function checkExpression() {
							if(cbCalled) { return; }
							var regexExpression = "^" + escapeRegExp(self.config.virtualServers[virtual_server]['rs_prefix']) + ".*";
							lrosRestAction('GET','/status/app/proxy/realServerGroup/' +
								encodeURI(self.config.virtualServers[virtual_server]['rs_group_name']) + '?op=list&level=recurse', {},
								function lrosSgExistsCb(err, result) {
									if(err) {
										failure.push(virtual_server);
										return callback(err);
									}
									var path = result['requestPath'] + "/memberRegex";
									var expressions = result[result['requestPath']].children[path].children || {};
									var expressionKeys = Object.keys(expressions);
									var expressionExists = false;
									expressionKeys.forEach(function(key){
										key = decodeURI(key.replace(path + "/", ""));
										if(key === regexExpression) { expressionExists = true; }
									});
									if(!expressionExists) {
										self.setServerGroupRegex(self.config.virtualServers[virtual_server]['rs_group_name'],
											regexExpression, function setSGRegexCallerCb(err, result) {
												if(err) {
													failure.push(err);
													cbCalled = true;
													return callback(err);
												}
												success.push(virtual_server);
												callback(null, virtual_server);
											}
										);
									} else {
										success.push(virtual_server);
										callback(null, virtual_server);
									}
								}
							);
						}
					}
				);
			},
			attachGroup: function attachGroup(callback) {
				// Is the Server Group attached to the VS? If not, add it
				lrosRestAction('GET','/status/app/proxy/virtualServer/' + virtual_server + '/realServerGroup?op=list', {},
				function lrosVsGroupExistsCb(err, result){
					if(err) {
						failure.push( { virtual_server: err } );
						return callback(err);
					}
					// Check all member groups for the one in the script config
					var doAttach = false;
					if(result[result['requestPath']].numChildren > 0) {
						var groups = Object.keys(result[result['requestPath']].children);
						var groupExists = false;
						groups.forEach(function(group){
							group = group.split("/").pop();
							if(group === self.config.virtualServers[virtual_server]['rs_group_name']) {
								groupExists = true;
							}
						});
						if(!groupExists) {
							doAttach = true;
						} else {
							success.push(virtual_server);
							return callback(null, virtual_server);
						}
					} else {
						doAttach = true;
					}
					if(doAttach) {
						self.attachServerGroup(virtual_server, self.config.virtualServers[virtual_server]['rs_group_name'],
							function setSGRegexCallerCb(err, result) {
								if(err) {
									failure.push(virtual_server);
									return callback(err);
								}
								success.push(virtual_server);
								return callback(null, virtual_server);
							}
						);
					}
				});
			}
		}, function groupTasksCb(err, result){
			if(err) {
				console.log("(AutoScaler) Error in Server Group Tasks: " + err);
				return callback(err);
			}
			return callback(null, null);
		});

	}, function afterEachVsCb(err, result) {
		failure.forEach(function(fTask){
			// If some tasks partially completed, treat them as full failures
			var r = success.indexOf(fTask);
			if(r != -1) {
				success.splice(r, 1);
			}
			// Remove duplicates in failure
			var f = totalFailure.indexOf(fTask);
			if(f == -1) {
				totalFailure.push(fTask);
			}
		});
		// Remove duplicates in success
		success.forEach(function(sTask){
			var s = totalSuccess.indexOf(sTask);
			if(s == -1) {
				totalSuccess.push(sTask);
			}
		});
		return callback(null, { success: totalSuccess, failure: totalFailure } );
	});
};

AutoScaler.prototype.createServerGroup = function(vs_group_name, callback) {
	this.restClient.postJSON(
		'/config/app/proxy/realServerGroup/' + encodeURI(vs_group_name),
		{
			"type": "string",
			"data": vs_group_name,
			"default": false
		},
		function createRsGroupCb(response) {
			if(response.statusCode != 200) {
				return callback("(AutoScaler) Error setting Real Server Group on LROS: " +
				encodeURI(vs_group_name));
			}
			return callback(null, vs_group_name);
		}
	);
};

AutoScaler.prototype.setServerGroupRegex = function(vs_group_name, vs_group_regex, callback) {
	this.restClient.postJSON(
		'/config/app/proxy/realServerGroup/' + encodeURI(vs_group_name) +
		'/memberRegex/' + encodeURI(vs_group_regex),
		{
			"type": "string",
			"data": vs_group_regex,
			"default": false
		},
		function setSGRegexCb(response) {
			if(response.statusCode != 200) {
				return callback("(AutoScaler) Error setting Real Server Group RegEx on LROS: " +
					vs_group_regex);
			}
			return callback(null, vs_group_name);
		});
};

AutoScaler.prototype.attachServerGroup = function(vs_name, vs_group_name, callback) {
	var self = this;

	this.restClient.postJSON(
		'/config/app/proxy/virtualServer/' + vs_name + '/realServerGroup/' + encodeURI(vs_group_name),
		{
			"type": "string",
			"data": vs_group_name,
			"default": false
		},
		function attachRsGroupCb(response) {
			if(response.statusCode != 200) {
				return callback("(AutoScaler) Error creating Real Server Group '" +
				vs_group_name + "' on LROS virtual server '" + vs_name + "'");
			}
			return callback(null, vs_name);
		}
	);
};

AutoScaler.prototype.createRealServer = function(virtual_server, instance, callback){
	var self = this;
	var instance_ip = this.config.virtualServers[virtual_server].amazon[instance];
	var instance_port = this.config.virtualServers[virtual_server].service_port || 80;
	var instance_name = this.config.virtualServers[virtual_server].rs_prefix + instance;

	if(!instance_ip) {
		// No IP Address
		return callback("No IP", {
			vs: virtual_server,
			instance: instance
		});
	}

	var basePath = '/config/app/proxy/realServer/' + encodeURI(instance_name);
	this.series({
			create: function (callback) {
				// Create RS(or ensure it exists)
				lrosRestAction('PUT', basePath,
					{
						data: encodeURI(instance_name),
						type: "string",
						default: false
					}, callback);
			},
			setIP: function (callback) {
				// Set/update RS IP Address:port
				lrosRestAction ('PUT', basePath + '/ipAddress',
					{
						data: {
							family: "af-inet",
							addr: instance_ip,
							port: instance_port
						},
						type: "socket-addr",
						default: false
					}, callback);
			},
			setBase: function (callback) {
				// Set/update RS service Type
				lrosRestAction('PUT', basePath + '/base',
					{
						data: self.config.virtualServers[virtual_server].rs_prefix + "base",
						type: "string",
						default: false
					}, callback);
			}
		}, function cRsCb(err, result) {
			if(err) {
				return callback("Error creating Real Server '" + instance + "': " + err,
					{ vs: virtual_server, instance: instance });
			}
			return callback (null, { vs: virtual_server, instance: instance });
		}
	);
};

AutoScaler.prototype.deleteRealServer = function(virtual_server, real_server_name, callback) {
	lrosRestAction("DELETE", "/config/app/proxy/realServer/" + encodeURI(real_server_name), {},
		function deleteRsCb(err, result) {
			return callback(err, {
				vs: virtual_server,
				rs: real_server_name,
				rest: result
			});
		}
	);
};

AutoScaler.prototype.removeRealServer = function(virtual_server, real_server_name, callback) {
	lrosRestAction("DELETE", "/config/app/proxy/virtualServer/" + encodeURI(virtual_server) +
		"/realServer/" + encodeURI(real_server_name), {},
		function deleteRsCb(err, result) {
			return callback(err, {
				vs: virtual_server,
				rs: real_server_name,
				rest: result
			});
		}
	);
};

AutoScaler.prototype.removeRealServerGroup = function(virtual_server, rs_group_name, callback) {
	lrosRestAction("DELETE", "/config/app/proxy/virtualServer/" + encodeURI(virtual_server) +
		"/realServerGroup/" + encodeURI(rs_group_name), {},
		function deleteRsCb(err, result) {
			return callback(err, {
				vs: virtual_server,
				rsg: rs_group_name,
				rest: result
			});
		}
	);
};

function escapeRegExp(string){
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = AutoScaler;