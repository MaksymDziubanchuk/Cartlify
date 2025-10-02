import type { UserId } from './ids.js';
import type { Email } from './common.js';

export type Role = 'GUEST' | 'USER' | 'ADMIN' | 'ROOT';

export interface User {
  id: UserId;
  email?: string;
  role: Role;
}

export interface UserEntity {
  id: UserId;
  email: Email;
  role: Role;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;

  name?: string;
  avatarUrl?: string;
  locale?: string;
  phone?: number;
}
