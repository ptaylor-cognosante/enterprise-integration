'use strict';

const AWS = require('aws-sdk');
var s3 = new AWS.S3();
const openpgp = require('openpgp');
openpgp.config.show_version = false;
openpgp.config.show_comment = false;

var Client = require('ssh2').Client;
var host = process.env.Host;
var port = process.env.Port;
var user = process.env.User;
var pwd = process.env.Password;

module.exports.handler = (event, context, callback) => {

    const s3bucket = event.Records[0].s3.bucket.name;
    const s3key = event.Records[0].s3.object.key.replace(/\+/g, ' ').replace(/%2B/g, '+');

    getS3UploadedCSVFileContent(s3bucket, s3key => {
        encryptFile(data => {
            uploadCSVFileOnSftpServer(s3bucket, s3key);
        });
    });

    var getS3UploadedCSVFileContent = function (s3bucket, s3key) {
        var params = {
            Bucket: s3bucket,
            Key: s3key
        }
        s3.getObject(params, function (err, data) {
            if (err) {
                console.log("Error in getting CSV file from S3 bucket", err);
            } else {
                console.log("Content is", data);
                var dataObject = data.Body.toString();
                return dataObject;
            }
        })
    }

    var encryptFile = function (data) {
        let fileBuffer = Buffer.from(data.Body);
        openpgp.initWorker({}); // initialise openpgpjs
        const openpgpPublicKey = openpgp.key.readArmored(Buffer.from(process.env.BASE64ENCODEDPUBLICKEY, 'base64').toString('ascii').trim());
        const fileForOpenpgpjs = new Uint8Array(fileBuffer);
        const options = {
            data: fileForOpenpgpjs,
            publicKeys: openpgpPublicKey.keys,
            armor: false
        };
        openpgp.encrypt(options).then(function (cipherText) {
            let encrypted = cipherText.message.packets.write();
            let s3params = {

                Body: Buffer.from(encrypted),
                Bucket: s3bucket,
                Key: s3key + '.pgp'
            };
            s3.putObject(s3params, function (err, data) {
                if (err) {
                    // eslint-disable-next-line
                    console.log(err, err.stack);
                } else {
                    //successfully encrypted file, delete unencrypted original
                    let deleteParams = {
                        Bucket: s3bucket,
                        Key: s3key,
                    };
                    s3.deleteObject(deleteParams, function (err, data) {
                        if (err) {
                            // eslint-disable-next-line 
                            console.log(err, err.stack);
                        } else {
                            // eslint-disable-next-line  
                            console.log('s3-pgp-encryptor replaced ' + s3bucket + '/' + s3key + ' with ' + s3key + '.pgp');
                        }
                    });
                }
            });
        });
    }

    var uploadCSVFileOnSftpServer = function (s3bucket, s3key) {
        var error;
        var filePath = '/tmp';
        var cipherText;
        var params = {
            Bucket: s3bucket,
            Key: s3key + '.pgp'
        }
        s3.getObject(params, function (err, data) {
            if (err) {
                console.log("Error in cipherText file from S3 bucket", err);
            } else {
                console.log("Content is", data);
                cipherText = data.Body.toString();
            }
        })
        var connSettings = {
            host: host,
            port: port,
            username: user,
            password: pwd
        };
        var conn = new Client();
        conn.on('ready', function () {
            conn.sftp(function (err, sftp) {
                if (err) {
                    console.log("Error in connection", err);
                    error = err;
                } else {
                    console.log("Connection established", sftp);
                    var options = Object.assign({}, {
                        encoding: 'utf-8'
                    }, true);
                    var stream = sftp.createWriteStream(filePath, options);
                    var data = stream.end(cipherText);
                    stream.on('close', function () {
                        console.log("- file transferred succesfully");
                        conn.end();
                    });
                }
            });
        }).connect(connSettings);
        if (error) {
            // eslint-disable-next-line

            console.log(error, error.stack);
        } else {
            //successfully sFTP file, delete encrypted cipherText
            let deleteParams = {                                                                                        
                Bucket: s3bucket,
                Key: s3key + '.pgp',
            };
            s3.deleteObject(deleteParams, function (err, data) {
                if (err) {
                    // eslint-disable-next-line 
                    console.log(err, err.stack);
                } else {
                    // eslint-disable-next-line  
                    console.log('s3-pgp-encryptor uploaded via sFTP to ' + s3bucket + '/' + s3key + ' with ' + s3key + '.pgp');
                }
            });
        }
    }
};