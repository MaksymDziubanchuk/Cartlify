export declare const EMAIL_BRAND: unique symbol;

export type Email = string & { readonly [EMAIL_BRAND]: true };

export interface MessageResponseDto {
  message: string;
}
