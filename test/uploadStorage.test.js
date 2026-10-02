// Every upload (product images, payment proofs, delivery photos) failed in production with
// "Cannot read properties of undefined (reading 'uploader')": multer-storage-cloudinary 2.x calls
// opts.cloudinary.v2.uploader, but it was given the v2 client itself. This drives a real multer upload
// through the storage with Cloudinary's upload_stream stubbed, so no network call is made.
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'test-cloud';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'test-key';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const cloudinary = require('../src/config/cloudinary');
const { paymentProofUpload } = require('../src/middleware/upload');

test('a payment proof upload reaches Cloudinary upload_stream with the payment-proofs folder', async (t) => {
  const calls = [];
  t.mock.method(cloudinary.uploader, 'upload_stream', (params, done) => {
    calls.push(params);
    const sink = new PassThrough();
    sink.on('finish', () => done(null, { secure_url: 'https://res.cloudinary.com/test/proof.png', public_id: 'nogatu/payment-proofs/x' }));
    sink.resume();
    return sink;
  });

  const storage = paymentProofUpload.storage;
  const file = { fieldname: 'proof', originalname: 'proof.png', mimetype: 'image/png', stream: new PassThrough() };
  const handled = new Promise((resolve, reject) => {
    storage._handleFile({}, file, (err, info) => (err ? reject(err) : resolve(info)));
  });
  file.stream.end(Buffer.from('fake image bytes'));

  const info = await handled;
  assert.equal(calls.length, 1, 'upload_stream was called once');
  assert.equal(calls[0].folder, 'nogatu/payment-proofs');
  // Controllers store req.file.path; before the adapter it was undefined and every upload 500ed.
  assert.equal(info.path, 'https://res.cloudinary.com/test/proof.png', 'req.file.path is the https URL');
  assert.equal(info.file_id, 'nogatu/payment-proofs/x', 'file_id lets multer remove the file on a later error');
});

test('an upload result without a URL fails the upload instead of storing an empty link', async (t) => {
  t.mock.method(cloudinary.uploader, 'upload_stream', (params, done) => {
    const sink = new PassThrough();
    sink.on('finish', () => done(null, { public_id: 'x' }));
    sink.resume();
    return sink;
  });
  const file = { fieldname: 'proof', originalname: 'proof.png', mimetype: 'image/png', stream: new PassThrough() };
  const handled = new Promise((resolve, reject) => {
    paymentProofUpload.storage._handleFile({}, file, (err, info) => (err ? reject(err) : resolve(info)));
  });
  file.stream.end(Buffer.from('fake image bytes'));
  await assert.rejects(handled, (err) => err.statusCode === 502);
});
