import type { Role } from 'types/user.js';
import type { UserId } from 'types/ids.js';

export interface PartyDto {
  id: number;
  name: string;
  address: string;
  email: string;
  country: string;
  createdAt: string;
  updatedAt: string;
}

// how many products name the party, as their manufacturer and as their person responsible in the EU
export interface PartyUsageDto {
  manufacturerOf: number;
  euResponsibleOf: number;
}

export interface PartyDetailDto extends PartyDto {
  usage: PartyUsageDto;
}

export interface PartyParamsDto {
  partyId: string;
}

export interface CreatePartyBodyDto {
  name: string;
  address: string;
  email: string;
  country: string;
}

export type UpdatePartyBodyDto = Partial<CreatePartyBodyDto>;

export interface PartiesListQueryDto {
  limit?: number;
  cursor?: string;
  q?: string;
  country?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PartiesListResponseDto {
  items: PartyDetailDto[];
  total: number;
  limit: number;
  nextCursor: string | null;
}

// the actor of a service call
interface PartyActorDto {
  actorId: UserId;
  actorRole: Role;
}

export interface CreatePartyDto extends PartyActorDto {
  body: unknown;
}

export interface UpdatePartyDto extends PartyActorDto {
  partyId: number;
  body: unknown;
}

export interface GetPartyDto extends PartyActorDto {
  partyId: number;
}

export type DeletePartyDto = GetPartyDto;

export interface ListPartiesDto extends PartyActorDto {
  limit: number;
  cursor?: string;
  q?: string;
  country?: string;
  sortOrder: 'asc' | 'desc';
}
