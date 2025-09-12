#!/usr/bin/env python3

"""
Enhanced Delta Service using curl_cffi with 100% success rate target
This service uses advanced strategies to achieve maximum success rate
"""

import json
import os
import time
import random
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, List

from curl_cffi import requests
from flask import Flask, request, jsonify

app = Flask(__name__)

# Enhanced browser strategies - only the most effective ones
EFFECTIVE_STRATEGIES = [
    "chrome131",      # Most reliable Chrome
    "chrome136",      # Latest Chrome
    "safari184",      # Most reliable Safari
    "safari260",      # Latest Safari
    "firefox135",     # Most reliable Firefox
]

# Fallback strategies for when primary ones fail
FALLBACK_STRATEGIES = [
    "chrome133a",     # Alternative Chrome
    "edge99",         # Edge fallback
    "edge101",        # Edge fallback
]

# All strategies combined
ALL_STRATEGIES = EFFECTIVE_STRATEGIES + FALLBACK_STRATEGIES

# Enhanced user agents with more variety
USER_AGENTS = [
    # Chrome variants
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    
    # Safari variants
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    
    # Firefox variants
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:109.0) Gecko/20100101 Firefox/135.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/135.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/135.0",
]

class EnhancedDeltaHandler:
    def __init__(self):
        self.strategy_success_rates = {strategy: 0.0 for strategy in ALL_STRATEGIES}
        self.strategy_attempts = {strategy: 0 for strategy in ALL_STRATEGIES}
        self.request_count = 0
        self.success_count = 0
        self.challenge_count = 0
        self.access_denied_count = 0
        self.last_request_time = 0
        self.consecutive_failures = 0
        self.current_strategy_index = 0
        
    def get_best_strategy(self) -> str:
        """Get the strategy with the highest success rate"""
        if not any(self.strategy_attempts.values()):
            # First request, use effective strategies
            return EFFECTIVE_STRATEGIES[self.current_strategy_index % len(EFFECTIVE_STRATEGIES)]
        
        # Calculate success rates
        success_rates = {}
        for strategy in ALL_STRATEGIES:
            if self.strategy_attempts[strategy] > 0:
                success_rates[strategy] = self.strategy_success_rates[strategy] / self.strategy_attempts[strategy]
            else:
                success_rates[strategy] = 0.0
        
        # Sort by success rate, then by attempts (prefer tried strategies)
        sorted_strategies = sorted(
            success_rates.items(), 
            key=lambda x: (x[1], self.strategy_attempts[x[0]]), 
            reverse=True
        )
        
        # If we have consecutive failures, try a different approach
        if self.consecutive_failures > 3:
            # Try strategies we haven't used much
            least_used = min(self.strategy_attempts.items(), key=lambda x: x[1])
            return least_used[0]
        
        return sorted_strategies[0][0]
    
    def get_enhanced_headers(self, strategy: str) -> Dict[str, str]:
        """Generate enhanced headers for the given strategy"""
        user_agent = random.choice(USER_AGENTS)
        
        base_headers = {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': user_agent,
            'origin': 'https://www.delta.com',
            'referer': 'https://www.delta.com/',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
        }
        
        # Strategy-specific headers
        if 'chrome' in strategy:
            base_headers.update({
                'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"macOS"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                'priority': 'u=1, i',
            })
        elif 'safari' in strategy:
            base_headers.update({
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                'accept-encoding': 'gzip, deflate, br',
            })
        elif 'firefox' in strategy:
            base_headers.update({
                'accept-encoding': 'gzip, deflate, br',
                'dnt': '1',
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
    
    def calculate_delay(self, attempt: int, strategy: str) -> float:
        """Calculate intelligent delay based on attempt and strategy performance"""
        # Base delay
        base_delay = 3.0 + random.uniform(0, 2.0)  # 3-5 seconds
        
        # Strategy-based delay (less successful strategies get longer delays)
        strategy_success_rate = 0.0
        if self.strategy_attempts[strategy] > 0:
            strategy_success_rate = self.strategy_success_rates[strategy] / self.strategy_attempts[strategy]
        
        # Lower success rate = longer delay
        strategy_delay = (1.0 - strategy_success_rate) * 5.0  # 0-5 seconds
        
        # Attempt-based delay
        attempt_delay = min(2.0 * (attempt - 1), 10.0)  # Max 10 seconds
        
        # Consecutive failure delay
        failure_delay = min(self.consecutive_failures * 2.0, 15.0)  # Max 15 seconds
        
        total_delay = base_delay + strategy_delay + attempt_delay + failure_delay
        return min(total_delay, 30.0)  # Cap at 30 seconds
    
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
    
    def is_access_denied(self, response) -> bool:
        """Check if response is 444 access denied"""
        return response.status_code == 444
    
    def update_strategy_stats(self, strategy: str, success: bool):
        """Update strategy statistics"""
        self.strategy_attempts[strategy] += 1
        if success:
            self.strategy_success_rates[strategy] += 1
            self.consecutive_failures = 0
        else:
            self.consecutive_failures += 1
    
    def make_delta_request(self, from_airport: str, to_airport: str, depart_date: str, 
                          max_retries: int = 10) -> Dict[str, Any]:
        """Make Delta API request with enhanced challenge handling"""
        
        # Ensure minimum delay between requests
        time_since_last = time.time() - self.last_request_time
        if time_since_last < 3.0:
            time.sleep(3.0 - time_since_last)
        
        self.request_count += 1
        
        for attempt in range(1, max_retries + 1):
            # Get best strategy for this attempt
            strategy = self.get_best_strategy()
            
            try:
                # Generate unique transaction ID
                transaction_id = f"{int(time.time() * 1000)}_{random.randint(100000, 999999)}"
                
                # Build request data (same as before)
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
                
                # Get enhanced headers
                headers = self.get_enhanced_headers(strategy)
                headers.update({
                    'airline': 'DL',
                    'applicationid': 'DC',
                    'authorization': 'GUEST',
                    'channelid': 'DCOM',
                    'content-type': 'application/json',
                    'transactionid': transaction_id,
                    'x-app-type': 'shop-mach',
                    'X-Attempt': str(attempt),
                    'X-Strategy': strategy,
                    'X-Request-ID': f"{from_airport}-{to_airport}-{depart_date}-{int(time.time())}"
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
                    self.update_strategy_stats(strategy, True)
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
                    self.update_strategy_stats(strategy, False)
                    
                    if attempt < max_retries:
                        delay = self.calculate_delay(attempt, strategy)
                        print(f"   Waiting {delay:.1f}s before retry...")
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
                
                elif self.is_access_denied(response):
                    self.access_denied_count += 1
                    print(f"🚪 ACCESS DENIED with {strategy} (attempt {attempt}) - Status: {response.status_code}")
                    self.update_strategy_stats(strategy, False)
                    
                    if attempt < max_retries:
                        delay = self.calculate_delay(attempt, strategy)
                        print(f"   Waiting {delay:.1f}s before retry...")
                        time.sleep(delay)
                        continue
                    else:
                        return {
                            'success': False,
                            'error': 'Access denied after max retries',
                            'strategy': strategy,
                            'attempt': attempt,
                            'status_code': response.status_code,
                            'response': response.text
                        }
                
                else:
                    print(f"❌ ERROR with {strategy} (attempt {attempt}) - Status: {response.status_code}")
                    self.update_strategy_stats(strategy, False)
                    
                    if attempt < max_retries:
                        delay = self.calculate_delay(attempt, strategy)
                        print(f"   Waiting {delay:.1f}s before retry...")
                        time.sleep(delay)
                        continue
                    else:
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
                self.update_strategy_stats(strategy, False)
                
                if attempt < max_retries:
                    delay = self.calculate_delay(attempt, strategy)
                    print(f"   Waiting {delay:.1f}s before retry...")
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

# Global enhanced handler
enhanced_handler = EnhancedDeltaHandler()

@app.route('/delta', methods=['POST'])
def delta_search():
    """Enhanced Delta search endpoint"""
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
        
        print(f"\n🔍 Enhanced Delta search: {from_airport} → {to_airport} on {depart_date}")
        
        # Make request with enhanced handler
        result = enhanced_handler.make_delta_request(from_airport, to_airport, depart_date)
        
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
                    'handler_stats': {
                        'total_requests': enhanced_handler.request_count,
                        'success_count': enhanced_handler.success_count,
                        'challenge_count': enhanced_handler.challenge_count,
                        'access_denied_count': enhanced_handler.access_denied_count,
                        'success_rate': enhanced_handler.success_count / max(enhanced_handler.request_count, 1) * 100
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
    """Enhanced health check with detailed statistics"""
    return jsonify({
        'status': 'healthy',
        'handler_stats': {
            'total_requests': enhanced_handler.request_count,
            'success_count': enhanced_handler.success_count,
            'challenge_count': enhanced_handler.challenge_count,
            'access_denied_count': enhanced_handler.access_denied_count,
            'success_rate': enhanced_handler.success_count / max(enhanced_handler.request_count, 1) * 100,
            'consecutive_failures': enhanced_handler.consecutive_failures
        },
        'strategy_performance': {
            strategy: {
                'attempts': enhanced_handler.strategy_attempts[strategy],
                'successes': enhanced_handler.strategy_success_rates[strategy],
                'success_rate': enhanced_handler.strategy_success_rates[strategy] / max(enhanced_handler.strategy_attempts[strategy], 1) * 100
            }
            for strategy in ALL_STRATEGIES
            if enhanced_handler.strategy_attempts[strategy] > 0
        }
    })

if __name__ == '__main__':
    print("🚀 Starting Enhanced Delta curl_cffi Service")
    print("🎯 Target: 100% Success Rate")
    print("📍 Effective strategies:", EFFECTIVE_STRATEGIES)
    print("🔄 Fallback strategies:", FALLBACK_STRATEGIES)
    print("🌐 Service will run on http://localhost:4007")
    
    app.run(host='0.0.0.0', port=4007, debug=True)
