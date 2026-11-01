// the name an order item goes by in a mail, an export and a payment page: the copy of the name of
// its variant that the confirmation kept (order_items."productName", db/05). A row from before the
// copies has none and goes by the name of its product
export const itemNameOf = (item: {
  productName: string | null;
  variantId: number;
  product: { name: string };
}): string => item.productName ?? item.product.name;
