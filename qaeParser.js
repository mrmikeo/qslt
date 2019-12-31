/*
*
* QAE - Version 0.0.1
*
* Qredit Always Evolving
*
* A simplified token management system for the Qredit network
*
* QAEParser - Parse the blockchain for QAE items
*
*/

const redis		  = require('redis');			 // a really fast nosql keystore
const fs		  = require('fs');				 // so we can read the config ini file from disk
const ini		  = require('ini');				 // so we can parse the ini files properties
const Big		  = require('big.js');			 // required unless you want floating point math issues
const nodemailer  = require('nodemailer');		 // for sending error reports about this node
const crypto	  = require('crypto');			 // for creating hashes of things
const SparkMD5	  = require('spark-md5');  		 // Faster than crypto for md5
const {promisify} = require('util');			 // Promise functions
const asyncv3	  = require('async');			 // Async Helper
const { Client }  = require('pg');				 // Postgres
const qreditjs	  = require("qreditjs");

var iniconfig = ini.parse(fs.readFileSync('/etc/qae/qae.ini', 'utf-8'))

// Mongo Connection Details
const mongoconnecturl = iniconfig.mongo_connection_string;
const mongodatabase = iniconfig.mongo_database;

// MongoDB Library
const qaeDB = require("./lib/qaeDB");
const qdb = new qaeDB.default(mongoconnecturl, mongodatabase);

// Connect to Redis and setup some async call definitions
const rclient	 = redis.createClient(iniconfig.redis_port, iniconfig.redis_host,{detect_buffers: true});
const rclienttwo = redis.createClient(iniconfig.redis_port, iniconfig.redis_host,{detect_buffers: true});
const hgetAsync  = promisify(rclient.hget).bind(rclient);
const hsetAsync  = promisify(rclient.hset).bind(rclient);
const getAsync	 = promisify(rclient.get).bind(rclient);
const setAsync	 = promisify(rclient.set).bind(rclient);
const delAsync	 = promisify(rclient.del).bind(rclient);

// QAE-1 Token Schema
const qaeSchema = require("./lib/qaeSchema");
const qae = new qaeSchema.default();

const qaeactivationHeight = 2859480;
const qaeactivationBlockId = 'c36c7920a5194e67c646145c54051d22f9b2f192cf458da8683e34af4a1582ac';
const qaeactivationRingSig = 'd09a4678959edd868a6d96dfdff286c43b0d3264193af20eb56a808e8a0b1397';

// Declaring some variable defaults

var scanBlockId = 0;
var lastBlockId = '';
var sigblockhash = '';
var sigtokenhash = '';
var sigaddrhash = '';
var sigtrxhash = '';
var previoushash = '';
var fullhash = '';
var processedItems = false;
var lastBlockNotify = Math.floor(new Date() / 1000);

var scanLock = false;
var scanLockTimer = 0;

// Let us know when we connect or have an error with redis
rclient.on('connect', function() {
	console.log('Connected to Redis');
});

rclient.on('error',function() {
	console.log("Error in Redis");
	error_handle("Error in Redis", 'redisConnection');
});

// Rescan Flag or Unknown last scan -  rescans all transaction (ie. #node qaeApiv2.js true)

rclient.get('qae_lastscanblock', function(err, lbreply)
{

	if ((process.argv.length == 3 && (process.argv[2] == '1' || process.argv[2] == 'true')) || lbreply == null || parseInt(lbreply) != lbreply) 
	{

		(async () => {
		
			console.log("--------------------");
			console.log("Forcing a Rescan....");
			console.log("--------------------");

			await delAsync('qae_lastscanblock');
			await delAsync('qae_lastblockid');
			await delAsync('qae_ringsignatures');
		
			await setAsync('qae_lastscanblock', qaeactivationHeight);
			await setAsync('qae_lastblockid', qaeactivationBlockId);
			await hsetAsync('qae_ringsignatures', qaeactivationHeight, qaeactivationRingSig);
			
			// Remove items from MongoDB
			
			let response = {};
			let exists = true;
				
			var mclient = await qdb.connect();
			qdb.setClient(mclient);
				
			exists = await qdb.doesCollectionExist('tokens');
			console.log("Does collection 'tokens' Exist: " + exists);
			if (exists == true)
			{
				console.log("Removing all documents from 'tokens'");
				await qdb.removeDocuments('tokens', {});
			}
			else
			{
				console.log("Creating new collection 'tokens'");
				await qdb.createCollection('tokens', {});
			}

			exists = await qdb.doesCollectionExist('addresses');
			console.log("Does collection 'addresses' Exist: " + exists);
			if (exists == true)
			{
				console.log("Removing all documents from 'addresses'");
				await qdb.removeDocuments('addresses', {});
			}
			else
			{
				console.log("Creating new collection 'addresses'");
				await qdb.createCollection('addresses', {});
			}
				
			exists = await qdb.doesCollectionExist('transactions');
			console.log("Does collection 'transactions' Exist: " + exists);
			if (exists == true)
			{
				console.log("Removing all documents from 'transactions'");
				await qdb.removeDocuments('transactions', {});
			}
			else
			{
				console.log("Creating new collection 'transactions'");
				await qdb.createCollection('transactions', {});
			}

			await qae.indexDatabase(qdb);
			
			await qdb.close();	
			
			// Initialze things
			initialize();
			
		})();
		
	}
	else
	{
		// Initialze things
		initialize(); 
	}	
	
});


// Main Functions
// ==========================

function initialize()
{

	downloadChain();
	blockNotifyQueue();

}

function blockNotifyQueue() 
{
  		
	rclienttwo.blpop('blockNotify', iniconfig.polling_interval, function(err, data)
	{

		if (data == 1)
		{
			newblocknotify();
		}
		else
		{
			var currentIntervalTime = Math.floor(new Date() / 1000);
			if (lastBlockNotify < (currentIntervalTime - iniconfig.polling_interval))
			{
				newblocknotify();
			}
		}
		
		blockNotifyQueue();
	
	});
	
}

function downloadChain()
{

	scanLock = true;
	scanLockTimer = Math.floor(new Date() / 1000);
	
	(async () => {
			
		var pgclient = new Client({user: iniconfig.pg_username, database: iniconfig.pg_database, password: iniconfig.pg_password});
		await pgclient.connect()
		var message = await pgclient.query('SELECT * FROM blocks ORDER BY height DESC LIMIT 1')
		await pgclient.end()
			
		
		var topHeight = 0;
		if (message && message.rows && message.rows[0].height)
		{
			var topHeight = message.rows[0].height;
			lastBlockId = message.rows[0].id;
		}
		
		console.log('Qredit Current Top Height #' + topHeight + '.....');

		scanLock = false;
		scanLockTimer = 0;

		doScan();
		
	})();

}


function doScan()
{

	scanLock = true;
	scanLockTimer = Math.floor(new Date() / 1000);
	
	rclient.get('qae_lastscanblock', function(err, reply){

		if (err)
		{
			console.log(err);
		}
		else if (reply == null || parseInt(reply) != reply)
		{
			scanBlockId = qaeactivationHeight;
		}
		else
		{
			scanBlockId = parseInt(reply);
		}
		
		//
		
		rclient.get('qae_lastblockid', function(err, replytwo){

			if (err)
			{
				console.log(err);
			}
			else if (reply == null)
			{
				lastBlockId = '';
			}
			else
			{
				lastBlockId = replytwo;
			}
		
		
			//
		
			console.log('Scanning from block #' + scanBlockId + '.....');

			(async () => {

				var currentHeight = 0;

				var pgclient = new Client({user: iniconfig.pg_username, database: iniconfig.pg_database, password: iniconfig.pg_password});
				await pgclient.connect()
				var message = await pgclient.query('SELECT * FROM blocks ORDER BY height DESC LIMIT 1');

				if (message && message.rows) currentHeight = parseInt(message.rows[0].height);
			
				console.log('Current Blockchain Height: ' + currentHeight);

				var mclient = await qdb.connect();
				qdb.setClient(mclient);
				
				await whilstScanBlocks(scanBlockId, currentHeight, pgclient, qdb);
				
									
			})();

		});
	
	});

}


async function whilstScanBlocks(count, max, pgclient, qdb)
{

	return new Promise((resolve) => {

		asyncv3.whilst(
			function test(cb) { cb(null, count < max) },
			function iter(callback) {
							
				count++;
			
				scanLockTimer = Math.floor(new Date() / 1000);
										
				if (count%1000 == 0 || count == max) console.log("Scanning: " + count);
				
				pgclient.query('SELECT id, number_of_transactions, height, previous_block FROM blocks WHERE height = $1 LIMIT 1', [count], (err, message) => {
							
					if (message && message.rows)
					{

						var blockdata = message.rows[0];

						if (blockdata && blockdata.id)
						{

							var blockidcode = blockdata.id;
							var blocktranscount = blockdata.number_of_transactions;
							var thisblockheight = blockdata.height;
						
							var previousblockid = blockdata.previous_block;

							if (lastBlockId != previousblockid && thisblockheight > 1)
							{
					
								console.log('Error:	 Last Block ID is incorrect!  Rescan Required!');
							
								console.log("Expected: " + previousblockid);
								console.log("Received: " + lastBlockId);
								console.log("ThisBlockHeight: " + thisblockheight);
								console.log("LastScanBlock: " + count);
							
								rclient.del('qae_lastblockid', function(err, reply){
									rclient.del('qae_lastscanblock', function(err, reply){
										process.exit(-1);
									});
								});
					
							}

							lastBlockId = blockidcode;
							
							processedItems = false;

							if (parseInt(blocktranscount) > 0 && thisblockheight >= qaeactivationHeight)
							{
				
								pgclient.query('SELECT * FROM transactions WHERE block_id = $1 ORDER BY sequence ASC', [blockidcode], (err, tresponse) => {
				
									if (tresponse && tresponse.rows)
									{
								
										var trxcounter = 0;
																
										//tresponse.rows.forEach( (origtxdata) => {
										
										asyncv3.each(tresponse.rows, function(origtxdata, callbackeach) {
						
											(async () => {
										
												var epochdate = new Date(Date.parse('2017-03-21 13:00:00'));
												var unixepochtime = Math.round(epochdate.getTime()/1000);
											
												var unixtimestamp = parseInt(origtxdata.timestamp) + unixepochtime;
												var humantimestamp = new Date(unixtimestamp * 1000).toISOString();
									
												var txdata = {};
												txdata.id = origtxdata.id
												txdata.blockId = origtxdata.block_id;
												txdata.version = origtxdata.version;
												txdata.type = origtxdata.type;
												txdata.amount = origtxdata.amount;
												txdata.fee = origtxdata.fee;
												txdata.sender = qreditjs.crypto.getAddress(origtxdata.sender_public_key);
												txdata.senderPublicKey = origtxdata.sender_public_key;
												txdata.recipient = origtxdata.recipient_id
												if (origtxdata.vendor_field_hex != null && origtxdata.vendor_field_hex != '')
												{
													txdata.vendorField = hex_to_ascii(origtxdata.vendor_field_hex.toString());
												}
												else
												{
													txdata.vendorField = null;
												}
												txdata.confirmations = parseInt(max) - parseInt(thisblockheight);
												txdata.timestamp = {epoch: origtxdata.timestamp, unix: unixtimestamp, human: humantimestamp};
										
												trxcounter++;
						
												if (txdata.vendorField && txdata.vendorField != '')
												{

													var isjson = false;
							
													try {
														JSON.parse(txdata.vendorField);
														isjson = true;
													} catch (e) {
														//console.log("VendorField is not JSON");
													}
							
													if (isjson === true)
													{
											
console.log(txdata);	
											
														var parsejson = JSON.parse(txdata.vendorField);
											
														if (parsejson.qae1)
														{
									
															var txmessage = await qdb.findDocuments('transactions', {"txid": txdata.id});
															if (txmessage.length == 0)
															{
																try {
																	var qaeresult = await qae.parseTransaction(txdata, blockdata, qdb);
																} catch (e) {
																	error_handle(e, 'parseTransaction', 'error');
																}
																processedItems = true;
															}
															else
															{
																console.log('ERROR:	 We already have TXID: ' + txdata.id);
															}
									
														}
							
													}
							
												}
												
												callbackeach();
							
											})();

										}, function(err) {

											if( err ) {
												console.log('An error occurred in async.each in whilst');
											} 
											
											(async () => {
												
												await processRingSignatures(thisblockheight, processedItems, pgclient, qdb);

												await setAsync('qae_lastscanblock', thisblockheight);
												await setAsync('qae_lastblockid', blockidcode);
													
												callback(null, count);
											
											})();

										});
					
									}
									else
									{
										// This needs to be handled.  TODO:	 Missing transactions when there should be some
										callback(null, count);
									}
									
								});
				
							}
							else
							{
								(async () => {
							
									await processRingSignatures(thisblockheight, false, pgclient, qdb);

									await setAsync('qae_lastscanblock', thisblockheight);
									await setAsync('qae_lastblockid', blockidcode);

									try {
										callback(null, count);
									} catch (e) {
										console.log(e);
									}
													
								})();
								
							}

						}
						else
						{

							console.log("Block #" + count + " missing blockdata info.. This is a fatal error...");
							process.exit(-1);
						
						}

					}
					else
					{
				
						console.log("Block #" + count + " not found in database.. This is a fatal error...");
						process.exit(-1);
				
					}

				});
			
			},
			function(err, n) {
		
				(async () => {
			
					await qdb.close();
					await pgclient.end()
				
					scanLock = false;
					scanLockTimer = 0;
				
					var nowTime = Math.floor(new Date() / 1000);
				
					if (gotSeedPeers < nowTime - 900) // Check for seeds every 15 minutes
					{
						gotSeedPeers = nowTime;
						getSeedPeers();
					}
				
					resolve(true);
		
				})();
			
			}
		
		);

	});

}

function processRingSignatures(thisblockheight, processedItems, pgclient, qdb)
{

	return new Promise(resolve => {

		(async () => {

			if (parseInt(thisblockheight) > parseInt(qaeactivationHeight))
			{
							
				rclient.hget('qae_ringsignatures', (parseInt(thisblockheight) - 1), function(err, reply)
				{
		
					previoushash = reply;

					(async () => {

						if (processedItems == true || sigblockhash == '' || sigtokenhash == '' || sigaddrhash == '' || sigtrxhash == '')
						{				

							// Only check if new things were processed or we have empty vars
							
							var message = await pgclient.query('SELECT * FROM blocks WHERE height = $1 LIMIT 1', [thisblockheight]);
												
							sigblockhash = message.rows[0].id;
							sigtokenhash = await qdb.findDocumentHash('tokens', {"lastUpdatedBlock": {$lte: thisblockheight}}, "tokenDetails.tokenIdHex", {"_id":-1});
							sigaddrhash = await qdb.findDocumentHash('addresses', {"lastUpdatedBlock": {$lte: thisblockheight}}, "recordId", {"_id":-1});
							sigtrxhash = await qdb.findDocumentHash('transactions', {"blockHeight": {$lte: thisblockheight}}, "txid", {"_id":-1});

						}
			
						fullhash = crypto.createHash('sha256').update(previoushash + sigblockhash + sigtokenhash + sigaddrhash + sigtrxhash).digest('hex');
		
						rclient.hset('qae_ringsignatures', thisblockheight, fullhash, function(err, reply)
						{
								
							resolve(true);
		
						});
		
					})();
		
				});
																							
			}
			else
			{
			
				// First Block @ QAE Activation
				
				await hsetAsync('qae_ringsignatures', thisblockheight, qaeactivationRingSig);
								
				resolve(true);
										  
			}
	
		})();
	
	});

}


function newblocknotify()
{

	lastBlockNotify = Math.floor(new Date() / 1000);
	
	console.log('New Block Notify..');

	if (scanLock == true)
	{
		// TODO:  Check if it is a stale lock
		var currentUnixTime = Math.floor(new Date() / 1000);
		if (scanLockTimer < (currentUnixTime - iniconfig.scanlock_staletime))
		{
			// force unlock
			console.log("Forcing scanlock Unlock....");
			scanLock = false;
		}
	
	
		console.log('Scanner already running...');
	}
	else
	{
		downloadChain();
	}
	
	return true;

}





// Helpers
// ==========================

function hex_to_ascii(str1)
{
	var hex	 = str1.toString();
	var str = '';
	for (var n = 0; n < hex.length; n += 2) {
		str += String.fromCharCode(parseInt(hex.substr(n, 2), 16));
	}
	return str;
}

function decimalPlaces(num) 
{
  var match = (Big(num).toString()).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) { return 0; }
  return Math.max(
	   0,
	   // Number of digits right of decimal point.
	   (match[1] ? match[1].length : 0)
	   // Adjust for scientific notation.
	   - (match[2] ? +match[2] : 0));
}

function truncateToDecimals(num, dec = 2) 
{
  const calcDec = Math.pow(10, dec);
  
  var bignum = new Big(num);
  var multiplied = parseInt(bignum.times(calcDec));
  var newbig = new Big(multiplied);
  var returnval = newbig.div(calcDec);

  return returnval.toFixed(dec);
}

function error_handle(error, caller = 'unknown', severity = 'error')
{

	var scriptname = 'qaeParser.js';

	console.log("Error Handle has been called!");

	let transporter = nodemailer.createTransport({
		sendmail: true,
		newline: 'unix',
		path: '/usr/sbin/sendmail'
	});
	transporter.sendMail({
		from: iniconfig.error_from_email,
		to: iniconfig.error_to_email,
		subject: 'OhNo! Error in ' + scriptname + ' at ' + caller,
		text: 'OhNo! Error in ' + scriptname + ' at ' + caller + '\n\n' + JSON.stringify(error)
	}, (err, info) => {
		console.log(err);
		console.log(info);
	});

}
	