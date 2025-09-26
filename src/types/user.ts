export type Role = 'GUEST' | 'USER' | 'ADMIN' | 'ROOT';

export interface User {
  id: string;
  email: string;
  role: Role;
}
