#!/usr/bin/env python3

"""
Delta Service using curl_cffi for better anti-bot bypass
This service uses curl_cffi to impersonate real browsers and bypass 429 challenges
"""

import json
import os
import time
import random
from datetime import datetime, timedelta
from typing import Dict, Any, Optional

from curl_cffi import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

# Browser impersonation strategies
BROWSER_STRATEGIES = [
    "chrome131",      # Chrome 131
    "chrome133a",     # Chrome 133a (alternative)
    "chrome136",      # Chrome 136
    "safari184",      # Safari 18.4
    "safari260",      # Safari 26.0
    "firefox135",     # Firefox 135
    "edge99",         # Edge 99
    "edge101",        # Edge 101
]

# User agents for additional randomization
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/135.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
]

class DeltaChallengeHandler:
    def __init__(self):
        self.current_strategy = 0
        self.request_count = 0
        self.last_request_time = 0
        self.success_count = 0
        self.challenge_count = 0
        
    def get_next_strategy(self) -> str:
        """Get next browser strategy for rotation"""
        strategy = BROWSER_STRATEGIES[self.current_strategy]
        self.current_strategy = (self.current_strategy + 1) % len(BROWSER_STRATEGIES)
        return strategy
    
    def get_random_headers(self, strategy: str) -> Dict[str, str]:
        """Generate realistic headers for the given strategy"""
        user_agent = random.choice(USER_AGENTS)
        
        base_headers = {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': user_agent,
            'origin': 'https://www.delta.com',
            'referer': 'https://www.delta.com/',
        }
        
        # Add strategy-specific headers
        if 'chrome' in strategy:
            base_headers.update({
                'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"macOS"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
            })
        elif 'safari' in strategy:
            base_headers.update({
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
            })
        elif 'firefox' in strategy:
            base_headers.update({
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
            })
        elif 'edge' in strategy:
            base_headers.update({
                'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
            })
        
        return base_headers
    
    def is_challenge_response(self, response) -> bool:
        """Check if response is a 429 challenge"""
        if response.status_code != 429:
            return False
        
        try:
            response_data = response.json()
            if isinstance(response_data, dict) and 'body' in response_data:
                body_data = json.loads(response_data['body'])
                return body_data.get('cpr_chlge') == 'true'
        except:
            pass
        
        return False
    
    def calculate_delay(self, attempt: int) -> float:
        """Calculate delay between requests and retries"""
        # Base delay between requests
        base_delay = 2.0 + random.uniform(0, 1.0)  # 2-3 seconds
        
        # Additional delay for retries
        if attempt > 1:
            retry_delay = min(5.0 * (1.5 ** (attempt - 2)), 30.0)  # Exponential backoff, max 30s
            return base_delay + retry_delay
        
        return base_delay
    
    def make_delta_request(self, from_airport: str, to_airport: str, depart_date: str, 
                          max_retries: int = 5) -> Dict[str, Any]:
        """Make Delta API request with challenge handling"""
        
        # Ensure minimum delay between requests
        time_since_last = time.time() - self.last_request_time
        if time_since_last < 2.0:
            time.sleep(2.0 - time_since_last)
        
        self.request_count += 1
        strategy = self.get_next_strategy()
        
        for attempt in range(1, max_retries + 1):
            try:
                # Generate unique transaction ID
                transaction_id = f"{int(time.time() * 1000)}_{random.randint(100000, 999999)}"
                
                # Build request data
                customers = [{"passengerTypeCode": "ADT", "passengerId": "1"}]
                
                post_data = {
                    "query": """query ($offerSearchCriteria: OfferSearchCriteriaInput!) {
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
        additionalOfferSetProperties {
          seatReferenceId
        }
      }
    }
  }
}""",
                    "variables": {
                        "offerSearchCriteria": {
                            "productGroups": [{"productCategoryCode": "FLIGHTS"}],
                            "offersCriteria": {
                                "resultsPageNum": 1,
                                "resultsPerRequestNum": 20,
                                "preferences": {
                                    "refundableOnly": False,
                                    "showGlobalRegionalUpgradeCertificate": True,
                                    "nonStopOnly": False
                                },
                                "pricingCriteria": {
                                    "priceableIn": ["MILES"]
                                },
                                "flightRequestCriteria": {
                                    "currentTripIndexId": "0",
                                    "sortableOptionId": None,
                                    "selectedOfferId": "",
                                    "searchOriginDestination": [{
                                        "departureLocalTs": f"{depart_date}T00:00:00",
                                        "destinations": [{"airportCode": to_airport}],
                                        "origins": [{"airportCode": from_airport}]
                                    }],
                                    "sortByBrandId": "BE",
                                    "additionalCriteriaMap": {
                                        "rollOutTag": "GBB"
                                    }
                                }
                            },
                            "customers": customers
                        }
                    }
                }
                
                # Get headers for current strategy
                headers = self.get_random_headers(strategy)
                headers.update({
                    'airline': 'DL',
                    'applicationid': 'DC',
                    'authorization': 'GUEST',
                    'channelid': 'DCOM',
                    'content-type': 'application/json',
                    'priority': 'u=1, i',
                    'transactionid': transaction_id,
                    'x-app-type': 'shop-mach'
                })
                
                # Make request with curl_cffi
                print(f"Making Delta request with {strategy} (attempt {attempt})")
                
                response = requests.post(
                    'https://offer-api-prd.delta.com/prd/rm-offer-gql',
                    json=post_data,
                    headers=headers,
                    impersonate=strategy,
                    timeout=30
                )
                
                self.last_request_time = time.time()
                
                if response.status_code == 200:
                    self.success_count += 1
                    print(f"✅ SUCCESS with {strategy} (attempt {attempt})")
                    return {
                        'success': True,
                        'data': response.json(),
                        'strategy': strategy,
                        'attempt': attempt,
                        'status_code': response.status_code
                    }
                
                elif self.is_challenge_response(response):
                    self.challenge_count += 1
                    print(f"🚫 CHALLENGE with {strategy} (attempt {attempt}) - Status: {response.status_code}")
                    
                    if attempt < max_retries:
                        # Switch strategy and wait
                        strategy = self.get_next_strategy()
                        delay = self.calculate_delay(attempt)
                        print(f"   Switching to {strategy}, waiting {delay:.1f}s...")
                        time.sleep(delay)
                        continue
                    else:
                        return {
                            'success': False,
                            'error': 'Challenge not resolved after max retries',
                            'strategy': strategy,
                            'attempt': attempt,
                            'status_code': response.status_code,
                            'response': response.text
                        }
                
                else:
                    print(f"❌ ERROR with {strategy} (attempt {attempt}) - Status: {response.status_code}")
                    return {
                        'success': False,
                        'error': f'HTTP {response.status_code}',
                        'strategy': strategy,
                        'attempt': attempt,
                        'status_code': response.status_code,
                        'response': response.text
                    }
                    
            except Exception as e:
                print(f"💥 EXCEPTION with {strategy} (attempt {attempt}) - {str(e)}")
                if attempt < max_retries:
                    delay = self.calculate_delay(attempt)
                    print(f"   Retrying in {delay:.1f}s...")
                    time.sleep(delay)
                    continue
                else:
                    return {
                        'success': False,
                        'error': str(e),
                        'strategy': strategy,
                        'attempt': attempt
                    }
        
        return {
            'success': False,
            'error': 'Max retries exceeded',
            'strategy': strategy,
            'attempt': max_retries
        }

# Global challenge handler
challenge_handler = DeltaChallengeHandler()

@app.route('/delta', methods=['POST'])
def delta_search():
    """Delta search endpoint with curl_cffi challenge handling"""
    try:
        data = request.get_json()
        from_airport = data.get('from')
        to_airport = data.get('to')
        depart_date = data.get('depart')
        adt = data.get('ADT', 1)
        
        if not all([from_airport, to_airport, depart_date]):
            return jsonify({
                'error': 'Missing required parameters: from, to, depart'
            }), 400
        
        print(f"\n🔍 Delta search: {from_airport} → {to_airport} on {depart_date}")
        
        # Make request with challenge handling
        result = challenge_handler.make_delta_request(from_airport, to_airport, depart_date)
        
        if result['success']:
            return jsonify(result['data'])
        else:
            return jsonify({
                'error': 'Delta API error',
                'status': result.get('status_code', 500),
                'body': result.get('response', result.get('error', 'Unknown error')),
                'debug': {
                    'strategy': result.get('strategy'),
                    'attempt': result.get('attempt'),
                    'challenge_handler_stats': {
                        'total_requests': challenge_handler.request_count,
                        'success_count': challenge_handler.success_count,
                        'challenge_count': challenge_handler.challenge_count
                    }
                }
            }), result.get('status_code', 500)
            
    except Exception as e:
        print(f"💥 Server error: {str(e)}")
        return jsonify({
            'error': 'Server error',
            'message': str(e)
        }), 500

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'challenge_handler_stats': {
            'total_requests': challenge_handler.request_count,
            'success_count': challenge_handler.success_count,
            'challenge_count': challenge_handler.challenge_count,
            'success_rate': challenge_handler.success_count / max(challenge_handler.request_count, 1) * 100
        }
    })

if __name__ == '__main__':
    print("🚀 Starting Delta curl_cffi Service")
    print("📍 Available strategies:", BROWSER_STRATEGIES)
    print("🌐 Service will run on http://localhost:4006")
    
    app.run(host='0.0.0.0', port=4006, debug=True)
