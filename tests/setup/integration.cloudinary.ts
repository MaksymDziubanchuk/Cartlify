import { holdCloudinaryInTestFolder } from '../helpers/cloudinary.js';

// every integration test file: an upload or a delete at Cloudinary outside the test/ folder fails,
// so a broken path never writes over or removes a file of dev or prod in the shared account
holdCloudinaryInTestFolder();
