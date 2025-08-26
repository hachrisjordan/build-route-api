require('dotenv').config();
const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { HttpsProxyAgent } = require('https-proxy-agent');
const compression = require('compression');

/**
 * Required environment variables for Oxylabs proxy:
 * - OXYLABS_USERNAME
 * - OXYLABS_PASSWORD
 * - OXYLABS_COUNTRY
 * - OXYLABS_PROXY
 */

const app = express();
app.use(express.json());
app.use(compression());

app.post('/delta', async (req, res) => {
  // Oxylabs proxy config
  const USE_PROXY = true;
  const username = process.env.OXYLABS_USERNAME;
  const password = process.env.OXYLABS_PASSWORD;
  const country = process.env.OXYLABS_COUNTRY;
  const proxy = process.env.OXYLABS_PROXY;
  
  if (USE_PROXY && (!username || !password || !country || !proxy)) {
    return res.status(500).json({ error: 'Oxylabs proxy configuration is missing. Please set OXYLABS_USERNAME, OXYLABS_PASSWORD, OXYLABS_COUNTRY, and OXYLABS_PROXY in your environment variables.' });
  }
  
  // Use HTTP proxy with advanced SSL handling to bypass SSL pinning
  const proxyAgent = USE_PROXY ? new HttpsProxyAgent(`http://${username}-cc-${country}:${password}@${proxy}`, {
    rejectUnauthorized: false, // Bypass SSL certificate validation
    secureProxy: false, // Allow insecure proxy connections
    keepAlive: true, // Keep connection alive
    timeout: 30000, // 30 second timeout
    // Additional SSL bypass options
    ciphers: 'ALL', // Accept all ciphers
    minVersion: 'TLSv1', // Accept older TLS versions
    maxVersion: 'TLSv1.3', // Accept newer TLS versions
  }) : undefined;

  const { from, to, depart, ADT } = req.body;
  
  try {
    console.log(`Using Oxylabs proxy with SSL bypass for Delta Airlines`);
    
    // Generate a unique transaction ID
    const transactionId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Build customers array based on ADT count
    const customers = Array.from({ length: ADT }, (_, index) => ({
      passengerTypeCode: "ADT",
      passengerId: String(index + 1)
    }));
    
    const postData = {
      query: `query ($offerSearchCriteria: OfferSearchCriteriaInput!) {
  gqlSearchOffers(offerSearchCriteria: $offerSearchCriteria) {
    offerResponseId
    gqlOffersSets {
      trips {
        tripId
        scheduledDepartureLocalTs
        scheduledArrivalLocalTs
        originAirportCode
        destinationAirportCode
        stopCnt
        flightSegment {
          aircraftTypeCode
          dayChange
          destinationAirportCode
          flightLeg {
            legId
            dayChange
            destinationAirportCode
            feeRestricted
            scheduledArrivalLocalTs
            scheduledDepartureLocalTs
            layover {
              destinationAirportCode
              layoverAirportCode
                    layoverDuration {
                      hourCnt
                      minuteCnt
                    }
              departureFlightNum
              equipmentChange
              originAirportCode
              scheduledArrivalLocalTs
              scheduledDepartureLocalTs
            }
            operatedByOwnerCarrier
            redEye
                  operatingCarrier {
                    carrierCode
                    carrierName
                  }
                  marketingCarrier {
                    carrierCode
                    carrierName
                  }
            earnLoyaltyMiles
            loyaltyMemberBenefits
            dominantLeg
                  duration {
                    dayCnt
                    hourCnt
                    minuteCnt
                  }
                  originAirport {
                    airportTerminals {
                      terminalId
                    }
                  }
                  destinationAirport {
                    airportTerminals {
                      terminalId
                    }
                  }
            originAirportCode
                  aircraft {
                    fleetTypeCode
                    subFleetTypeCode
                    newSubFleetType
                  }
            carrierCode
                  distance {
                    unitOfMeasure
                    unitOfMeasureCnt
                  }
          }
          layover {
            destinationAirportCode
            layoverAirportCode
                  layoverDuration {
                    hourCnt
                    minuteCnt
                  }
            departureFlightNum
            equipmentChange
            originAirportCode
            scheduledArrivalLocalTs
            scheduledDepartureLocalTs
          }
                marketingCarrier {
                  carrierCode
                  carrierNum
                }
                operatingCarrier {
                  carrierCode
                  carrierNum
                  carrierName
                }
          pendingGovtApproval
          destinationCityCode
          flightSegmentNum
          originAirportCode
          originCityCode
          scheduledArrivalLocalTs
          scheduledDepartureLocalTs
                aircraft {
                  fleetTypeCode
                  subFleetTypeCode
                  newSubFleetType
                }
              }
              totalTripTime {
                dayCnt
                hourCnt
                minuteCnt
              }
        summarizedProductId
      }
      additionalOfferSetProperties {
              globalUpgradeCertificateTripStatus {
                brandId
                upgradeAvailableStatusProductId
              }
              regionalUpgradeCertificateTripStatus {
                brandId
                upgradeAvailableStatusProductId
              }
        offerSetId
        seatReferenceId
              discountInfo {
                discountPct
                discountTypeCode
                nonDiscountedOffersAvailable
              }
              promotionsInfo {
                promotionalCode
                promotionalPct
              }
              discountInEligibilityList {
                code
                reason
              }
            }
            offerSetBadges {
              brandId
            }
      offers {
        offerId
        additionalOfferProperties {
          offered
          offerPriorityNum
          fareType
          dominantSegmentBrandId
          priorityNum
          soldOut
          unavailableForSale
          refundable
                offerBadges {
                  brandId
                }
          payWithMilesEligible
          discountAvailable
          travelPolicyStatus
          secondarySolutionRefIds
        }
        soldOut
        offerItems {
          retailItems {
            retailItemMetaData {
              fareInformation {
                solutionId
                ticketDesignatorCode
                      brandByFlightLegs {
                        brandId
                        cosCode
                        tripId
                        product {
                          brandId
                          typeCode
                        }
                        globalUpgradeCertificateLegStatus {
                          upgradeAvailableStatusProductId
                        }
                        regionalUpgradeCertificateLegStatus {
                          upgradeAvailableStatusProductId
                        }
                        flightSegmentNum
                        flightLegNum
                      }
                      discountInEligibilityList {
                        code
                        reason
                      }
                availableSeatCnt
                farePrice {
                        discountsApplied {
                          pct
                          code
                          description
                          reason
                          amount {
                            currencyEquivalentPrice {
                              currencyAmt
                            }
                            milesEquivalentPrice {
                              mileCnt
                              discountMileCnt
                            }
                          }
                        }
                  totalFarePrice {
                          currencyEquivalentPrice {
                            roundedCurrencyAmt
                            formattedCurrencyAmt
                          }
                          milesEquivalentPrice {
                            mileCnt
                            cashPlusMilesCnt
                            cashPlusMiles
                          }
                  }
                  originalTotalPrice {
                          currencyEquivalentPrice {
                            roundedCurrencyAmt
                            formattedCurrencyAmt
                          }
                          milesEquivalentPrice {
                            mileCnt
                            cashPlusMilesCnt
                            cashPlusMiles
                          }
                  }
                  promotionalPrices {
                    price {
                            currencyEquivalentPrice {
                              roundedCurrencyAmt
                              formattedCurrencyAmt
                            }
                            milesEquivalentPrice {
                              mileCnt
                              cashPlusMilesCnt
                              cashPlusMiles
                            }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    offerDataList {
      responseProperties {
              discountInfo {
                discountPct
                discountTypeCode
                nonDiscountedOffersAvailable
              }
              promotionsInfo {
                promotionalCode
                promotionalPct
              }
              discountInEligibilityList {
                code
                reason
              }
        resultsPerRequestNum
        pageResultCnt
        resultsPageNum
              sortOptionsList {
                sortableOptionDesc
                sortableOptionId
              }
        tripTypeText
      }
      offerPreferences {
        stopCnt
        destinationAirportCode
              connectionTimeRange {
                maximumNum
                minimumNum
              }
        originAirportCode
              flightDurationRange {
                maximumNum
                minimumNum
              }
        layoverAirportCode
              totalMilesRange {
                maximumNum
                minimumNum
              }
              totalPriceRange {
                maximumNum
                minimumNum
              }
            }
            retailItemDefinitionList {
              brandType
              retailItemBrandId
              refundable
              retailItemPriorityText
            }
            pricingOptions {
              pricingOptionDetail {
                currencyCode
              }
            }
    }
    gqlSelectedOfferSets {
      trips {
        tripId
        scheduledDepartureLocalTs
        scheduledArrivalLocalTs
        originAirportCode
        destinationAirportCode
        stopCnt
        flightSegment {
          destinationAirportCode
                marketingCarrier {
                  carrierCode
                  carrierNum
                }
                operatingCarrier {
                  carrierCode
                  carrierNum
                }
          flightSegmentNum
          originAirportCode
          scheduledArrivalLocalTs
          scheduledDepartureLocalTs
                aircraft {
                  fleetTypeCode
                  subFleetTypeCode
                  newSubFleetType
                }
          flightLeg {
            destinationAirportCode
            feeRestricted
            layover {
              destinationAirportCode
              layoverAirportCode
                    layoverDuration {
                      hourCnt
                      minuteCnt
                    }
              departureFlightNum
              equipmentChange
              originAirportCode
              scheduledArrivalLocalTs
              scheduledDepartureLocalTs
            }
            operatedByOwnerCarrier
            redEye
                  operatingCarrier {
                    carrierCode
                    carrierName
                  }
                  marketingCarrier {
                    carrierCode
                    carrierName
                  }
            earnLoyaltyMiles
            loyaltyMemberBenefits
            dominantLeg
                  duration {
                    dayCnt
                    hourCnt
                    minuteCnt
                  }
                  originAirport {
                    airportTerminals {
                      terminalId
                    }
                  }
                  destinationAirport {
                    airportTerminals {
                      terminalId
                    }
                  }
            originAirportCode
                  aircraft {
                    fleetTypeCode
                    subFleetTypeCode
                    newSubFleetType
                  }
            carrierCode
                  distance {
                    unitOfMeasure
                    unitOfMeasureCnt
                  }
            scheduledArrivalLocalTs
            scheduledDepartureLocalTs
            dayChange
            legId
          }
        }
              totalTripTime {
                dayCnt
                hourCnt
                minuteCnt
              }
      }
      offers {
              additionalOfferProperties {
                dominantSegmentBrandId
                fareType
              }
        soldOut
        offerItems {
          retailItems {
            retailItemMetaData {
                    fareInformation {
                      brandByFlightLegs {
                        tripId
                        brandId
                        cosCode
                      }
                    }
                  }
                }
              }
            }
            additionalOfferSetProperties {
              seatReferenceId
            }
          }
        }
      }`,
      variables: {
        offerSearchCriteria: {
          productGroups: [
            {
              productCategoryCode: "FLIGHTS"
            }
          ],
        offersCriteria: {
          resultsPageNum: 1,
          resultsPerRequestNum: 20,
          preferences: {
            refundableOnly: false,
            showGlobalRegionalUpgradeCertificate: true,
            nonStopOnly: false
          },
            pricingCriteria: {
              priceableIn: ["MILES"]
            },
          flightRequestCriteria: {
              currentTripIndexId: "0",
            sortableOptionId: null,
              selectedOfferId: "",
            searchOriginDestination: [
              {
                departureLocalTs: `${depart}T00:00:00`,
                  destinations: [
                    {
                      airportCode: to
                    }
                  ],
                  origins: [
                    {
                      airportCode: from
                    }
                  ]
                }
              ],
              sortByBrandId: "BE",
              additionalCriteriaMap: {
                rollOutTag: "GBB"
              }
            }
          },
          customers: customers
        }
      }
    };

    const url = 'https://offer-api-prd.delta.com/prd/rm-offer-gql';
    const fetchOptions = {
      method: 'POST',
      headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'airline': 'DL',
      'applicationid': 'DC',
      'authorization': 'GUEST',
      'channelid': 'DCOM',
      'content-type': 'application/json',
      'origin': 'https://www.delta.com',
      'priority': 'u=1, i',
      'referer': 'https://www.delta.com/',
      'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
      'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
        'transactionid': transactionId,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      'x-app-type': 'shop-mach'
      },
      body: JSON.stringify(postData),
    };
    
    if (USE_PROXY) fetchOptions.agent = proxyAgent;
    
    console.log(`Making request to Delta Airlines through Oxylabs proxy`);
    const response = await fetch(url, fetchOptions);
    
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: 'Delta API error', status: response.status, body: errorText });
    }
    
    const json = await response.json();
    console.log(`✅ SUCCESS - got valid response from Delta Airlines through Oxylabs proxy`);
    res.status(200).json(json);
    
  } catch (err) {
    console.log(`❌ Network error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.listen(4005, () => console.log('Delta microservice running on port 4005'));


