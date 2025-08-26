import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { encryptResponseAES } from '@/lib/aes-encryption';

const LiveSearchDLSchema = z.object({
  from: z.string().min(3), // Origin
  to: z.string().min(3), // Destination
  depart: z.string().min(8), // Outbound Date (YYYY-MM-DD)
  ADT: z.number().int().min(1).max(9), // Adults
});

function normalizeDeltaItineraries(data: any): any[] {
  if (!data || !data.data || !data.data.gqlSearchOffers || !data.data.gqlSearchOffers.gqlOffersSets) {
    return [];
  }

  const offerSets = data.data.gqlSearchOffers.gqlOffersSets;
  
  return offerSets.map((offerSet: any) => {
    const trips = offerSet.trips || [];
    const offers = offerSet.offers || [];
    
    return trips.map((trip: any) => {
      const flightSegments = trip.flightSegment || [];
      const totalTripTime = trip.totalTripTime || {};
      
      // Calculate total trip duration in minutes
      const totalDurationMinutes = (totalTripTime.dayCnt || 0) * 24 * 60 + 
                                  (totalTripTime.hourCnt || 0) * 60 + 
                                  (totalTripTime.minuteCnt || 0);
      
      // Extract pricing information from offers
      let bundles: any[] = [];
      if (offers.length > 0) {
        console.log('DEBUG: Number of offers:', offers.length);
        console.log('DEBUG: First offer structure:', JSON.stringify(offers[0], null, 2));
        
        bundles = offers.map((offer: any, index: number) => {
          // Navigate through the nested structure to get pricing
          const retailItems = offer.offerItems?.[0]?.retailItems || [];
          if (retailItems.length === 0) {
            console.log(`DEBUG: No retail items for offer ${index}`);
            return null;
          }
          
          const fareInformation = retailItems[0]?.retailItemMetaData?.fareInformation || [];
          if (fareInformation.length === 0) {
            console.log(`DEBUG: No fare information for offer ${index}`);
            return null;
          }
          
          const fareInfo = fareInformation[0];
          const totalFarePrice = fareInfo?.farePrice?.[0]?.totalFarePrice;
          const brandByFlightLegs = fareInfo?.brandByFlightLegs || [];
          
          console.log(`DEBUG: Offer ${index} - totalFarePrice:`, totalFarePrice);
          console.log(`DEBUG: Offer ${index} - brandByFlightLegs:`, brandByFlightLegs);
          console.log(`DEBUG: Offer ${index} - First brandId:`, brandByFlightLegs[0]?.brandId);
          console.log(`DEBUG: Offer ${index} - dominantSegmentBrandId:`, offer.additionalOfferProperties?.dominantSegmentBrandId);
          
          // Map brandId to cabin class - use dominantSegmentBrandId for the overall cabin class
          const dominantBrandId = offer.additionalOfferProperties?.dominantSegmentBrandId || 'MAIN';
          let cabinClass = 'Y'; // Default to Economy
          
          if (dominantBrandId === 'D1' || dominantBrandId === 'BU' || dominantBrandId === 'KEPC') {
            cabinClass = 'J'; // Business/First
          } else if (dominantBrandId === 'DPPS' || dominantBrandId === 'PE') {
            cabinClass = 'W'; // Premium
          } else if (dominantBrandId === 'MAIN' || dominantBrandId === 'DCP' || dominantBrandId === 'KEEC' || dominantBrandId === 'E') {
            cabinClass = 'Y'; // Economy (including Comfort+)
          }
          
          console.log(`DEBUG: Dominant Brand ID ${dominantBrandId} mapped to cabin class ${cabinClass}`);
          
          const bundle = {
            class: cabinClass,
            points: totalFarePrice?.milesEquivalentPrice?.mileCnt || "0",
            fareTax: totalFarePrice?.currencyEquivalentPrice?.formattedCurrencyAmt || "0"
          };
          
          console.log(`DEBUG: Created bundle for offer ${index}:`, bundle);
          
          // Only return bundles with valid pricing data
          if (bundle.points === "0" || bundle.fareTax === "0") {
            console.log(`DEBUG: Skipping bundle ${index} due to invalid pricing`);
            return null;
          }
          
          return bundle;
        }).filter(Boolean); // Remove null entries
        
        console.log('DEBUG: Final bundles:', bundles);
        
        // Filter to only return the cheapest option for each cabin class
        const cheapestByClass: { [key: string]: any } = {};
        bundles.forEach(bundle => {
          const points = parseInt(bundle.points);
          if (!cheapestByClass[bundle.class] || points < parseInt(cheapestByClass[bundle.class].points)) {
            cheapestByClass[bundle.class] = bundle;
          }
        });
        
        bundles = Object.values(cheapestByClass);
        console.log('DEBUG: Filtered bundles (cheapest per class):', bundles);
      }
      
      // Create segments with detailed flight info
      const segments = flightSegments.map((segment: any, segmentIndex: number) => {
        const flightLegs = segment.flightLeg || [];
        
        return flightLegs.map((leg: any) => {
          // Calculate segment duration in minutes (ignore dayCnt)
          const segmentDuration = (leg.duration?.hourCnt || 0) * 60 + (leg.duration?.minuteCnt || 0);
          
          // Extract layover information
          let layoverMinutes = 0;
          if (segment.layover && segment.layover.layoverDuration) {
            layoverMinutes = (segment.layover.layoverDuration.hourCnt || 0) * 60 + 
                            (segment.layover.layoverDuration.minuteCnt || 0);
          }
          
          // Build flight number
          const flightNumber = `${leg.marketingCarrier?.carrierCode || leg.operatingCarrier?.carrierCode || 'DL'}${segment.marketingCarrier?.carrierNum || ''}`;
          
          // Create bundleClasses for this segment based on brandByFlightLegs
          const bundleClasses: any[] = [];
          
          // For each bundle, check what cabin class it gets on this specific segment
          bundles.forEach((bundle) => {
            // Find the brand info for this specific segment from the bundle's offer
            const bundleOffer = offers.find((offer: any) => {
              const offerBundles = offer.offerItems?.[0]?.retailItems?.[0]?.retailItemMetaData?.fareInformation?.[0]?.farePrice?.[0]?.totalFarePrice?.milesEquivalentPrice?.mileCnt;
              return offerBundles === bundle.points;
            });
            
            if (bundleOffer) {
              const segmentBrands = bundleOffer.offerItems?.[0]?.retailItems?.[0]?.retailItemMetaData?.fareInformation?.[0]?.brandByFlightLegs || [];
              const segmentBrand = segmentBrands.find((brand: any) => brand.flightSegmentNum === String(segmentIndex + 1));
              
              if (segmentBrand) {
                const brandId = segmentBrand.brandId;
                let segmentClass = 'Y'; // Default to Economy
                
                if (brandId === 'D1' || brandId === 'BU' || brandId === 'KEPC' || brandId === 'FIRST') {
                  segmentClass = 'J';
                } else if (brandId === 'DPPS' || brandId === 'PE') {
                  segmentClass = 'W';
                } else if (brandId === 'MAIN' || brandId === 'DCP' || brandId === 'KEEC' || brandId === 'E') {
                  segmentClass = 'Y';
                }
                
                // Add bundleClasses showing what this bundle gets on this segment
                const classKey = `${bundle.class}Class`;
                bundleClasses.push({ [classKey]: segmentClass });
              }
            }
          });
          
          return {
            from: segment.originAirportCode,
            to: segment.destinationAirportCode,
            aircraft: segment.aircraft?.fleetTypeCode || leg.aircraft?.fleetTypeCode || undefined,
            stops: segment.stopCnt || 0,
            depart: segment.scheduledDepartureLocalTs,
            arrive: segment.scheduledArrivalLocalTs,
            flightnumber: flightNumber,
            duration: segmentDuration,
            layover: layoverMinutes,
            distance: leg.distance?.unitOfMeasureCnt || undefined,
            ...(bundleClasses.length > 0 ? { bundleClasses } : {})
          };
        });
      }).flat();
      
      return {
        from: trip.originAirportCode,
        to: trip.destinationAirportCode,
        connections: flightSegments.length > 1 
          ? flightSegments.slice(0, -1).map((segment: any) => segment.destinationAirportCode)
          : [],
        depart: trip.scheduledDepartureLocalTs?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
        arrive: trip.scheduledArrivalLocalTs?.replace(/([\+\-][0-9]{2}:?[0-9]{2}|Z)$/g, ''),
        duration: totalDurationMinutes,
        bundles,
        segments
      };
      });
  }).flat();
}

export async function POST(req: NextRequest) {
  if (req.method !== 'POST') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  
  try {
    const body = await req.json();
    const parsed = LiveSearchDLSchema.safeParse(body);
    
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid input', details: parsed.error.errors }, { status: 400 });
    }

    const { from, to, depart, ADT } = parsed.data;

    // Call Delta microservice
    const microserviceUrl = 'http://localhost:4005/delta';
    const microResp = await fetch(microserviceUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, depart, ADT }),
    });
    
    if (!microResp.ok) {
      const errorText = await microResp.text();
      return NextResponse.json({ 
        error: 'Delta microservice error', 
        status: microResp.status, 
        body: errorText 
      }, { status: microResp.status });
    }
    
    const json = await microResp.json();
    const itinerary = normalizeDeltaItineraries(json);
    
    // Encrypt the response
    const { token, expiresAt } = encryptResponseAES({ itinerary });
    
    return NextResponse.json({
      encrypted: true,
      token,
      expiresAt
    });
    
  } catch (err) {
    console.error('Error in live-search-DL POST:', err);
    return NextResponse.json({ 
      error: 'Internal server error', 
      details: (err as Error).message 
    }, { status: 500 });
  }
}


