export function compareHotels(hotels = []) {
  return { options: hotels.map((hotel) => ({ propertyId: hotel.propertyId, name: hotel.name, totalPrice: hotel.totalPrice, currency: hotel.currency, rating: hotel.rating, reviewScore: hotel.reviewScore, roomType: hotel.roomType, cancellation: hotel.cancellation, sourceUrl: hotel.sourceUrl, priceStatus: hotel.priceStatus })), note: "Research facts only; no hotel score or recommendation is assigned." };
}
