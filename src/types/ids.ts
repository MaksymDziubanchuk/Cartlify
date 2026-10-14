export type UserId = string | number;
export type ProductId = number;
export type OrderId = number;
export type ReviewId = number;
export type CategoryId = number;

// a numeric id in the url path: params schemas take it as a digit string (^[1-9][0-9]*$),
// controllers turn it into a number before calling services
export type IdParam = string;
