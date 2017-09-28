const AWS = require('aws-sdk');
const { Writable } = require('stream');
const { merge } = require('lodash');
const retry = require('retry');

const defaultBuffer = {
  timeout: 5,
  length: 10,
  hasPriority: function () {
    return false;
  },
  retry: {
    retries: 2,
    minTimeout: 300,
    maxTimeout: 500
  }
};

class FirehoseStream extends Writable {
  constructor({ firehose, streamName, accessKeyId, secretAccessKey, region,
    httpOptions, objectMode, buffer, partitionKey }) {
    super({ objectMode });
    this.streamName = streamName;
    this.buffer = merge(defaultBuffer, buffer);
    this.partitionKey = partitionKey || function getPartitionKey() {
      return Date.now().toString();
    };

    this.hasPriority = this.buffer.isPrioritaryMsg || this.buffer.hasPriority;

    // increase the timeout to get credentials from the EC2 Metadata Service
//     AWS.config.credentials = new AWS.EC2MetadataCredentials({
//       httpOptions: httpOptions || { timeout: 5000 }
//     });

    this.recordsQueue = [];

    this.firehose = firehose || new AWS.Firehose({
      accessKeyId,
      secretAccessKey,
      region,
      httpOptions
    });
  }
  dispatch(records, cb) {
    if (records.length === 0) {
      return cb ? cb() : null;
    }

    const operation = retry.operation(this.buffer.retry);

    const partitionKey = this.partitionKey();

    const formattedRecords = records.map((record) => {
      // , PartitionKey: partitionKey
      return { Data: JSON.stringify(record) };
    });

    operation.attempt(() => {
      this.putRecords(formattedRecords, (err) => {
        if (operation.retry(err)) {
          return;
        }

        if (err) {
          this.emitRecordError(err, records);
        }

        if (cb) {
          return cb(err ? operation.mainError() : null);
        }
      });
    });
  };

  parseChunk(chunk) {
    if (Buffer.isBuffer(chunk)) {
      chunk = chunk.toString();
    }
    if (typeof chunk === 'string') {
      chunk = JSON.parse(chunk);
    }
    return chunk;
  }

  write(chunk, enc, next) {
    chunk = this.parseChunk(chunk);

    const hasPriority = this.hasPriority(chunk);
    if (hasPriority) {
      this.recordsQueue.unshift(chunk);
    } else {
      this.recordsQueue.push(chunk);
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    if (this.recordsQueue.length >= this.buffer.length || hasPriority) {
      this.flush();
    } else {
      this.timer = setTimeout(this.flush.bind(this), this.buffer.timeout * 1000);
    }

    if (next) return next();
  }

  emitRecordError(err, records) {
    err.records = records;
    this.emit('error', err);
  };

  flush() {
    this.dispatch(this.recordsQueue.splice(0, this.buffer.length));
  }

  putRecords(records, cb) {
    const req = this.firehose.putRecordBatch({
      DeliveryStreamName: this.streamName,
      Records: records
    }, cb);

    // remove all listeners which end up leaking
    req.on('complete', function () {
      if (req.error) {
        throw new Error(req.error.message);
      } 
      req.removeAllListeners();
      req.response.httpResponse.stream.removeAllListeners();
      req.httpRequest.stream.removeAllListeners();
    });
  }
  emitRecordError(err, records) {
    err.records = records;
    this.emit('error', err);
  };
}

module.exports = FirehoseStream;
