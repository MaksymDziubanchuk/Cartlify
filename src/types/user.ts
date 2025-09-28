import { UserId } from './ids.js';
export type Role = 'GUEST' | 'USER' | 'ADMIN' | 'ROOT';

export interface User {
  id: UserId;
  email?: string;
  role: Role;
}
