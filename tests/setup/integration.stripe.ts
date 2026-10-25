import { installStripe } from '../helpers/stripe.js';

// every integration test file: Stripe answers from a mock of its own, or from the test sandbox when
// the run names it (service:stripe)
installStripe();
