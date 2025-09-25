export type Role = 'USER' | 'ADMIN' | 'ROOT';

export interface User {
  id: string;
  email: string;
  role: Role;
}
