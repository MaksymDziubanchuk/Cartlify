import { acceptReturn } from './services/acceptReturn.service.js';
import { closeReturnRows } from './services/closeReturnRows.service.js';
import { confirmReturnProof } from './services/confirmReturnProof.service.js';
import { createReturn } from './services/createReturn.service.js';
import { getReturn } from './services/getReturn.service.js';
import { listReturns, listReturnsCsv } from './services/listReturns.service.js';
import { markReturnRefundedOutside } from './services/markReturnRefundedOutside.service.js';
import { receiveReturnItems } from './services/receiveReturnItems.service.js';
import { recordReturnReimbursement } from './services/recordReturnReimbursement.service.js';
import { recordReturnShipment } from './services/recordReturnShipment.service.js';
import { refundReturn } from './services/refundReturn.service.js';
import { setReturnShipmentCost } from './services/setReturnShipmentCost.service.js';
import { settleReturnDispute } from './services/settleReturnDispute.service.js';

export const returnsServices = {
  acceptReturn,
  closeReturnRows,
  confirmReturnProof,
  createReturn,
  getReturn,
  listReturns,
  listReturnsCsv,
  markReturnRefundedOutside,
  receiveReturnItems,
  recordReturnReimbursement,
  recordReturnShipment,
  refundReturn,
  setReturnShipmentCost,
  settleReturnDispute,
};
