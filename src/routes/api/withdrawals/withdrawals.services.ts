import { listWithdrawableItems } from './services/listWithdrawableItems.service.js';
import { provideFormProof } from './services/provideFormProof.service.js';
import { routeWithdrawal } from './services/routeWithdrawal.service.js';
import { submitWithdrawalForm } from './services/submitWithdrawalForm.service.js';

export const withdrawalsServices = {
  listWithdrawableItems,
  provideFormProof,
  routeWithdrawal,
  submitWithdrawalForm,
};
