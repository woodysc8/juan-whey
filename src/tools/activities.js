import { amadeusGet } from "../amadeusClient.js";

/**
 * Bookable tours/activities near a lat/lng, with real prices where available.
 * Use searchAirports or a quick geocode first if you only have a city name.
 */
export async function searchActivities({ latitude, longitude, radius = 5 }) {
  const data = await amadeusGet("/v1/shopping/activities", {
    latitude,
    longitude,
    radius, // km
  });

  const activities = (data.data || []).map((a) => ({
    name: a.name,
    shortDescription: a.shortDescription,
    price: a.price ? { amount: Number(a.price.amount), currency: a.price.currencyCode } : null,
    rating: a.rating,
    bookingLink: a.bookingLink,
    pictures: a.pictures?.slice(0, 1) || [],
  }));

  activities.sort((a, b) => (a.price?.amount ?? Infinity) - (b.price?.amount ?? Infinity));

  return { latitude, longitude, radiusKm: radius, count: activities.length, activities };
}
