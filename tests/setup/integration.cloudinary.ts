import { installCloudinary } from '../helpers/cloudinary.js';

// every integration test file: Cloudinary answers from a mock, or from the real account when the
// run names it; an upload or a delete outside the test/ folder fails, so a broken path never writes
// over or removes a file of dev or prod in the shared account
installCloudinary();
