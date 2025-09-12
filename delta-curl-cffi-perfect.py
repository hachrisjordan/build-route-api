#!/usr/bin/env python3

"""
Perfect Delta Service using curl_cffi - Target: 100% Success Rate
Uses ALL open source browser strategies randomly for maximum success
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

# ALL open source strategies from curl_cffi documentation
ALL_OPEN_SOURCE_STRATEGIES = [
    # Chrome variants
    "chrome99", "chrome100", "chrome101", "chrome104", "chrome107", 
    "chrome110", "chrome116", "chrome119", "chrome120", "chrome123", 
    "chrome124", "chrome131", "chrome133a", "chrome136",
    
    # Chrome Android
    "chrome99_android", "chrome131_android",
    
    # Safari variants
    "safari153", "safari155", "safari170", "safari180", "safari184", "safari260",
    
    # Safari iOS
    "safari172_ios", "safari180_ios", "safari184_ios", "safari260_ios",
    
    # Firefox variants
    "firefox133", "firefox135",
    
    # Tor
    "tor145",
    
    # Edge variants
    "edge99", "edge101"
]

# Premium user agents for each strategy type
PREMIUM_USER_AGENTS = {
    'chrome': [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    ],
    'chrome_android': [
        "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    ],
    'safari': [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    ],
    'safari_ios': [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
        "Mozilla/5.0 (iPad; CPU OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
    ],
    'firefox': [
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7; rv:109.0) Gecko/20100101 Firefox/135.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/135.0",
        "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/135.0",
    ],
    'tor': [
        "Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/135.0",
    ],
    'edge': [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    ]
}

class PerfectDeltaHandler:
    def __init__(self):
        self.strategy_success_rates = {strategy: 0.0 for strategy in ALL_OPEN_SOURCE_STRATEGIES}
        self.strategy_attempts = {strategy: 0 for strategy in ALL_OPEN_SOURCE_STRATEGIES}
        self.request_count = 0
        self.success_count = 0
        self.challenge_count = 0
        self.access_denied_count = 0
        self.timeout_count = 0
        self.last_request_time = 0
        self.consecutive_failures = 0
        self.strategy_rotation_count = 0
        
    def get_random_strategy(self) -> str:
        """Get a completely random strategy from all open source options"""
        return random.choice(ALL_OPEN_SOURCE_STRATEGIES)
    
    def get_strategy_user_agent(self, strategy: str) -> str:
        """Get appropriate user agent for the strategy"""
        if 'chrome' in strategy and 'android' not in strategy:
            return random.choice(PREMIUM_USER_AGENTS['chrome'])
        elif 'chrome' in strategy and 'android' in strategy:
            return random.choice(PREMIUM_USER_AGENTS['chrome_android'])
        elif 'safari' in strategy and 'ios' not in strategy:
            return random.choice(PREMIUM_USER_AGENTS['safari'])
        elif 'safari' in strategy and 'ios' in strategy:
            return random.choice(PREMIUM_USER_AGENTS['safari_ios'])
        elif 'firefox' in strategy:
            return random.choice(PREMIUM_USER_AGENTS['firefox'])
        elif 'tor' in strategy:
            return random.choice(PREMIUM_USER_AGENTS['tor'])
        elif 'edge' in strategy:
            return random.choice(PREMIUM_USER_AGENTS['edge'])
        else:
            # Fallback to Chrome
            return random.choice(PREMIUM_USER_AGENTS['chrome'])
    
    def get_perfect_headers(self, strategy: str) -> Dict[str, str]:
        """Generate perfect headers for maximum success"""
        user_agent = self.get_strategy_user_agent(strategy)
        
        base_headers = {
            'accept': 'application/json, text/plain, */*',
            'accept-language': 'en-US,en;q=0.9',
            'user-agent': user_agent,
            'origin': 'https://www.delta.com',
            'referer': 'https://www.delta.com/',
            'cache-control': 'no-cache',
            'pragma': 'no-cache',
            'accept-encoding': 'gzip, deflate, br',
        }
        
        # Strategy-specific perfect headers
        if 'chrome' in strategy:
            base_headers.update({
                'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
                'sec-ch-ua-mobile': '?0' if 'android' not in strategy else '?1',
                'sec-ch-ua-platform': '"macOS"' if 'android' not in strategy else '"Android"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                'priority': 'u=1, i',
                'upgrade-insecure-requests': '1',
            })
        elif 'safari' in strategy:
            base_headers.update({
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                'upgrade-insecure-requests': '1',
            })
        elif 'firefox' in strategy:
            base_headers.update({
                'dnt': '1',
                'upgrade-insecure-requests': '1',
            })
        elif 'tor' in strategy:
            base_headers.update({
                'dnt': '1',
                'upgrade-insecure-requests': '1',
            })
        elif 'edge' in strategy:
            base_headers.update({
                'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-site',
                'upgrade-insecure-requests': '1',
            })
        
        return base_headers
    
    def calculate_perfect_delay(self, attempt: int, strategy: str) -> float:
        """Calculate minimal delay - just try different browsers immediately"""
        # Minimal delay - just enough to avoid rate limiting
        base_delay = 1.0 + random.uniform(0, 2.0)  # 1-3 seconds
        
        # Very small delay for consecutive failures
        failure_delay = min(self.consecutive_failures * 0.5, 2.0)  # Max 2 seconds
        
        # Random jitter to avoid patterns
        jitter = random.uniform(0, 1.0)
        
        total_delay = base_delay + failure_delay + jitter
        return min(total_delay, 5.0)  # Cap at 5 seconds
    
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
                          max_retries: int = 20) -> Dict[str, Any]:
        """Make Delta API request with perfect challenge handling"""
        
        # Ensure minimal delay between requests - just enough to avoid rate limiting
        time_since_last = time.time() - self.last_request_time
        if time_since_last < 2.0:  # Minimum 2 seconds between requests
            time.sleep(2.0 - time_since_last)
        
        self.request_count += 1
        
        for attempt in range(1, max_retries + 1):
            # Get completely random strategy for this attempt
            strategy = self.get_random_strategy()
            
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
                
                # Get perfect headers
                headers = self.get_perfect_headers(strategy)
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
                    timeout=90  # Longer timeout
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
                        delay = self.calculate_perfect_delay(attempt, strategy)
                        print(f"   Trying different browser in {delay:.1f}s...")
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
                        delay = self.calculate_perfect_delay(attempt, strategy)
                        print(f"   Trying different browser in {delay:.1f}s...")
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
                        delay = self.calculate_perfect_delay(attempt, strategy)
                        print(f"   Trying different browser in {delay:.1f}s...")
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
                
                if "timeout" in str(e).lower():
                    self.timeout_count += 1
                
                if attempt < max_retries:
                    delay = self.calculate_perfect_delay(attempt, strategy)
                    print(f"   Trying different browser in {delay:.1f}s...")
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

# Global perfect handler
perfect_handler = PerfectDeltaHandler()

@app.route('/delta', methods=['POST'])
def delta_search():
    """Perfect Delta search endpoint"""
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
        
        print(f"\n🎯 Perfect Delta search: {from_airport} → {to_airport} on {depart_date}")
        
        # Make request with perfect handler
        result = perfect_handler.make_delta_request(from_airport, to_airport, depart_date)
        
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
                        'total_requests': perfect_handler.request_count,
                        'success_count': perfect_handler.success_count,
                        'challenge_count': perfect_handler.challenge_count,
                        'access_denied_count': perfect_handler.access_denied_count,
                        'timeout_count': perfect_handler.timeout_count,
                        'success_rate': perfect_handler.success_count / max(perfect_handler.request_count, 1) * 100
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
    """Perfect health check with comprehensive statistics"""
    return jsonify({
        'status': 'healthy',
        'handler_stats': {
            'total_requests': perfect_handler.request_count,
            'success_count': perfect_handler.success_count,
            'challenge_count': perfect_handler.challenge_count,
            'access_denied_count': perfect_handler.access_denied_count,
            'timeout_count': perfect_handler.timeout_count,
            'success_rate': perfect_handler.success_count / max(perfect_handler.request_count, 1) * 100,
            'consecutive_failures': perfect_handler.consecutive_failures
        },
        'strategy_performance': {
            strategy: {
                'attempts': perfect_handler.strategy_attempts[strategy],
                'successes': perfect_handler.strategy_success_rates[strategy],
                'success_rate': perfect_handler.strategy_success_rates[strategy] / max(perfect_handler.strategy_attempts[strategy], 1) * 100
            }
            for strategy in ALL_OPEN_SOURCE_STRATEGIES
            if perfect_handler.strategy_attempts[strategy] > 0
        }
    })

if __name__ == '__main__':
    print("🎯 Starting Perfect Delta curl_cffi Service")
    print("🏆 Target: 100% Success Rate")
    print(f"🎲 Using {len(ALL_OPEN_SOURCE_STRATEGIES)} random open source strategies")
    print("🌐 Service will run on http://localhost:4009")
    
    app.run(host='0.0.0.0', port=4009, debug=True)
