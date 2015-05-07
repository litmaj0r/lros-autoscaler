# AWS AutoScaling with LineRate Precision
 This script will interact with Amazon Web Services EC2's Auto Scaling feature in order to dynamically and automatically add and remove Real Servers from the LineRate configuration as necessary. Upon startup, it will do some initialization tasks:

## LineRate Initialization Functionality (LineRateAutoScaler.js)
* Main configuration of all Amazon and LineRate system information + script behavior
* Initializes SNS Processor and AutoScale modules on the system and reacts when master processes fail
  * Script configuration parameters:
    * (required, integer) timeout - number of seconds for asyncronous actions to be delayed until considering them failed
	  * (required, string) redis_channel - name of the Redis channel to publish SNS Notification events to, AutoScaler actions to be taken from
	  * (required, integer) pendingInstanceTimeout - number of seconds to wait until polling Amazon when an instance is booting and information is not available
	  * (required, integer) retryAttempts - number of attempts for polls to the LineRate REST API or AWS API before generating an error
	  * (required, integer) retryDelay - number of seconds for polls to the LineRate REST API or AWS API before reattempting the action
  * Amazon configuration parameters: 
    * (required, string) region - the Amazon region for API polls to be sent to
	  * (required, string) sslEnabled - whether or not the AWS SDK will use SSL for its queries
  * LineRate configuration parameters: 
    * (required, object) restCredentials; contains Strings of 'username' and 'password'
    * 'snsListener'
		  * (required, string) vip_name - the name for the Virtual IP and Virtual Server that handles HTTP SNS Notifications on LineRate
		  * (required, string) vip_ip  - the IP address for the script to listen for HTTP SNS Notifications on
		  * (required, string) vip_port - the port for the script to listen for HTTP SNS Notifications on
    * (required, object) 'virtualServer'
      * (required, string) name of Virtual Servers to attach Amazon EC2 instances to
      * (optional, integer) service_port - defaults to port 80
			* (optional, string) service_type - 'TCP' or 'HTTP'; defaults to HTTP
			* (optional, string) description - information about this VS to appear inlogs
			* (required, string) rs_prefix - the name added to the beginning of all new Real Servers created by this script; also used for the Real Server Group name
			* (optional, string) health_monitor - the name of a pre-configured Health Monitor for the script to attach to all Real Servers created by this script
			* (required, string) as_group_name - the name of the AutoScaling group in AWS for the script to poll
			* (optional, string) amazonIpType - 'private' or 'public'; used to specify what IP Address type to use from EC2 instances
* Establishes REST API connectivity with the LineRate System

## SNS Processor Functionality (snsProcessor.js)
 (runs on all LineRate processes)
 * Ensures an SNS Listener Virtual IP exists on LineRate, if not, creates it
 * Ensures an SNS Listener Virtual Server exists on LineRate, if not, creates it
 * Ensures configured SNS Subscriptions have been confirmed, if not, reattempts the subscription
 * Listens only for "addInstance", "removeInstance", and "subscriptionConfirmation" SNS events; relays information to the AutoScale master process

## AutoScaler Functionality (AutoScaler.js)
 (runs on master process only)
 * Initilization, for each configured Virtual Server:
   * Ensures the Virtual Server exists on LineRate, if not, emits a warning
   * Ensures the configured Real Server Group (RSG) exists on LineRate, if not, creates it
   * Ensures the a Real Server Base for exists for new Real Servers, if not, creates it with script-configured service information
   * Fetches instance state from LineRate and from Amazon (ie. currently running instances)
   * Removes Real Servers from the Virtual Server that have the configured Amazon RS prefix, but no longer exist in Amazon
 * Listens for addInstance and removeInstance notifications from SNS Listener:
    * On an addInstance notifications:
      * Create a new Real Server with the configured Amazon Real Server prefix/Amazon instance ID and fetched IP information
      * Attaches the configured Health Monitor, if specified, to the new Real Server
    * On a removeInstance notifications:
      * Deletes the Real Server from LineRate

## Other considerations:
 * In this version of code, all real servers in a virtual server must use the same port
 * Only one amazon Real Server Group can be configured and managed by this script. Others may exist on the Virtual Server, and will not be affected by the script.
 * Health Monitors that are configured in the script but don't exist on LineRate are still attached to new Real Servers; they will become functional if and when the Health Monitors are created and enabled
 * Virtual Servers that are configured in the script but don't exist on LineRate will still have Real Servers/Real Server Bases/Real Server Groups created upon recieving notifications from Amazon's SNS; when the Real Server Group is attached to a Virtual Server manually by the administrator, they will become active and usable by the system
 
## Initial Setup:
> scripting npm install "lros-autoscaler"

This installs all dependencies (aws-sdk@2.1.7, async@0.9.0, redis@0.12.0)

### Amazon environment requirements
 1. Setup an SNS topic/subscription ... https://us-west-2.console.aws.amazon.com/sns/home
 2. Configure the lros-autoscale script's LineRateAutoScaler.js file with all Amazon and LineRate information
 3. Setup an IAM User/Role ensuring it has access to both SNS and EC2... https://console.aws.amazon.com/iam/home

NOTE: Having the SNS listener use HTTPS requires use of an Amazon trusted CA. See http://docs.aws.amazon.com/sns/latest/dg/SendMessageToHttp.https.ca.html
