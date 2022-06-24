/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2016, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */


import MetricsConstants from '../../constants/MetricsConstants';
import SwitchRequest from '../SwitchRequest';
import FactoryMaker from '../../../core/FactoryMaker';
import { HTTPRequest } from '../../vo/metrics/HTTPRequest';
import EventBus from '../../../core/EventBus';
import Events from '../../../core/events/Events';
import Debug from '../../../core/Debug';
import MediaPlayerEvents from '../../MediaPlayerEvents';

// PADA_STATE_ONE_BITRATE   : If there is only one bitrate (or initialization failed), always return NO_CHANGE.
// PADA_STATE_STARTUP       : PADA state when downloading fragments at most recently measured throughput.
// PADA_STATE_STEADY        : Buffer primed, we switch to steady operation.

const PADA_STATE_ONE_BITRATE        = 0;
const PADA_STATE_STARTUP            = 1;
const PADA_STATE_STEADY             = 2;


const MINIMUM_BUFFER_S = 10; // low buffer threshold
const MINIMUM_BUFFER_PER_BITRATE_LEVEL_S = 2;
// E.g. if there are 5 bitrates, BOLA switches to top bitrate at buffer = 10 + 5 * 2 = 20s.
// If Schedule Controller does not allow buffer to reach that level, it can be achieved through the placeholder buffer level.

const PLACEHOLDER_BUFFER_DECAY = 0.99; // Make sure placeholder buffer does not stick around too long.

function PadaRule(config) {

    config = config || {};
    const context = this.context;

    const dashMetrics = config.dashMetrics;
    const mediaPlayerModel = config.mediaPlayerModel;
    const eventBus = EventBus(context).getInstance();

    

    let instance,
        logger,
        padaStateDict,
        bitrateSwitches,
        lastQuality,
        prio; 

    function setup() {
        logger = Debug(context).getInstance().getLogger(instance);
        resetInitialSettings();

        eventBus.on(MediaPlayerEvents.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.on(MediaPlayerEvents.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        eventBus.on(MediaPlayerEvents.METRIC_ADDED, onMetricAdded, instance);
        eventBus.on(MediaPlayerEvents.QUALITY_CHANGE_REQUESTED, onQualityChangeRequested, instance);
        eventBus.on(MediaPlayerEvents.FRAGMENT_LOADING_ABANDONED, onFragmentLoadingAbandoned, instance);

        eventBus.on(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);

    }

    function utilitiesFromBitrates(bitrates) {
        return bitrates.map(b => Math.log(b));
    }

    //gets the bitrate list for each priority
    function bitratesForPriority(bitrates, priority){
        const tempBitrates = [];
        if(bitrates.length == 1)
            return bitrates;
        else{
            for(let i=0; i<bitrates.length; i++)
                //if(bitrates[i]<= throughput)
                    tempBitrates.push(bitrates[i]);
            /*if(tempBitrates.length == 0){
                tempBitrates.push(bitrates[0]);
                return tempBitrates;
            }
            else if(tempBitrates.length == 1)
                return tempBitrates;
            else if(tempBitrates.length == 2){
                if(priority == 1 || priority == 2)
                    tempBitrates.pop();
            }*/
            //else{
            if(priority == 1)
                for(let j=0; j<3; j++)
                    tempBitrates.pop();
            else if(priority == 2)
                for(let j=0; j<2; j++)
                    tempBitrates.pop();
            //else if (priority == 3)
            //    tempBitrates.pop();
            //}
            
            /*if(priority == 1)
                tempBitrates.pop(); //low priority -- no need to reach the highest bitrate
            else if (priority == 2){
                tempBitrates.pop();
                for(let i = 0; i< tempBitrates.length/3; i++)
                    tempBitrates.shift(); //medium priority -- only consider 2/3 of the total bitrates
            }
            else if (priority == 3){
                const len = parseInt((2*tempBitrates.length)/3,10);
                for(let i = 0; i<len; i++)
                    tempBitrates.shift(); //high priority -- only consider 1/3 of the total bitrates        
            }*/
            return tempBitrates;
        }
    }

    function calculatePadaParameters(stableBufferTime, bitrates, utilities) {
        const highestUtilityIndex = utilities.reduce((highestIndex, u, uIndex) => (u > utilities[highestIndex] ? uIndex : highestIndex), 0);

        if (highestUtilityIndex === 0) {
            return null;
        }

        const bufferTime = Math.max(stableBufferTime, MINIMUM_BUFFER_S + MINIMUM_BUFFER_PER_BITRATE_LEVEL_S * bitrates.length);

        //These are used by BOLA. We keep them for now even if we are not using them 
        const gp = (utilities[highestUtilityIndex] - 1) / (bufferTime / MINIMUM_BUFFER_S - 1);
        const Vp = MINIMUM_BUFFER_S / gp;

        logger.info('gp = ' + gp + ' Vp = ' + Vp);

        return {gp: gp, Vp: Vp};
    }

    function getInitialPadaState(rulesContext) {
        const initialState = {};
        prio = rulesContext.getAbrController().getPriority();
        logger.info('------Priority is: ' + prio);
        const mediaInfo = rulesContext.getMediaInfo();
        let bitrates = mediaInfo.bitrateList.map(b => b.bandwidth); //
        logger.info('---- Bitrates are: ' + bitrates);
        let utilities = utilitiesFromBitrates(bitrates);
        utilities = utilities.map(u => u - utilities[0] + 1); // normalize
        logger.info('Utilities: ' + utilities);
        logger.info('rates: ' + rates);
        const rates = bitratesForPriority(bitrates, prio);
        const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        const params = calculatePadaParameters(stableBufferTime, bitrates, utilities);
        bitrateSwitches = 0;
        lastQuality = -1;
        if (!params) {
            // only happens when there is just one bitrate level
            initialState.state = PADA_STATE_ONE_BITRATE;
        } else {
            initialState.state = PADA_STATE_STARTUP;
            initialState.bitrates = rates;
            initialState.utilities = utilities;
            initialState.stableBufferTime = stableBufferTime;
            initialState.Vp = params.Vp;
            initialState.gp = params.gp;
            initialState.lastQuality = -1;
            initialState.lastThroughput = 0;
            initialState.priority = prio;
            initialState.lastRequestTimeMs = 0;
            initialState.lastFragmentDuration = 0;
            initialState.lastSegmentFinishTime = 0;
            clearPadaStateOnSeek(initialState);
        }

        return initialState;
    }

    function clearPadaStateOnSeek(padaState) {
        padaState.placeholderBuffer = 0;
        padaState.mostAdvancedSegmentStart = NaN;
        padaState.lastSegmentWasReplacement = false;
        padaState.lastSegmentStart = NaN;
        padaState.lastSegmentDurationS = NaN;
        padaState.lastSegmentRequestTimeMs = NaN;
        padaState.lastSegmentFinishTimeMs = NaN;
    }

    // If the buffer target is changed (can this happen mid-stream?), then adjust BOLA parameters accordingly.
    function checkPadaStateStableBufferTime(padaState, mediaType) {
        const stableBufferTime = mediaPlayerModel.getStableBufferTime();
        if (padaState.stableBufferTime !== stableBufferTime) {
            const params = calculatePadaParameters(stableBufferTime, padaState.bitrates, padaState.utilities);
            if (params.Vp !== padaState.Vp || params.gp !== padaState.gp) {
                // correct placeholder buffer using two criteria:
                // 1. do not change effective buffer level at effectiveBufferLevel === MINIMUM_BUFFER_S ( === Vp * gp )
                // 2. scale placeholder buffer by Vp subject to offset indicated in 1.

                const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
                let effectiveBufferLevel = bufferLevel + padaState.placeholderBuffer;

                effectiveBufferLevel -= MINIMUM_BUFFER_S;
                effectiveBufferLevel *= params.Vp / padaState.Vp;
                effectiveBufferLevel += MINIMUM_BUFFER_S;

                padaState.stableBufferTime = stableBufferTime;
                padaState.Vp = params.Vp;
                padaState.gp = params.gp;
                padaState.placeholderBuffer = Math.max(0, effectiveBufferLevel - bufferLevel);
            }
        }
    }

    function getPadaState(rulesContext) {
        const mediaType = rulesContext.getMediaType();
        let padaState = padaStateDict[mediaType];
        if (!padaState) {
            padaState = getInitialPadaState(rulesContext);
            padaStateDict[mediaType] = padaState;
        } else if (padaState.state !== PADA_STATE_ONE_BITRATE) {
            checkPadaStateStableBufferTime(padaState, mediaType);
        }
        return padaState;
    }

    // The core idea of PADA.
    function getQualityFromBufferLevel(padaState, bufferLevel, type) {
        logger.info('Priority' + prio + '~ buffer level = ' + bufferLevel + ' placeholderBuffer = ' + padaState.placeholderBuffer);
        logger.info('lastQuality = ' + lastQuality);
        logger.info('padaState.bitrates: ' + padaState.bitrates)
        const bitrate = padaState.bitrates[lastQuality];
        //logger.info('lastFragmentDuration = ' + padaState.lastFragmentDuration);
        //logger.info('lastSegmentFinishtimeMs - lastSegmentRequestTimeMs = ' + (padaState.lastSegmentFinishTime - padaState.lastRequestTimeMs));
        const throughput = .8*((bitrate*padaState.lastFragmentDuration)/((padaState.lastSegmentFinishTime - padaState.lastRequestTimeMs)/1000));
        logger.info('throughput = ' + throughput);
        //logger.info('bitrates for priority' + prio + ' are: ' + rates);
        const bitrateCount = padaState.bitrates.length;
        logger.info('bitrateCount = ' + bitrateCount);
        let quality = -1;
        
        //first check the mediaType - If audio, get the highest bitrate 
        if(type == 'audio'){
            quality = bitrateCount - 1;
            logger.info('quality for priority' + prio +  ' is: ' + quality);
        }
        else if (type == 'video'){
            //in case there is only one bitrate - always return the same quality
            if(padaState.state == PADA_STATE_ONE_BITRATE)
                return quality = 0;
            
            if(bufferLevel < MINIMUM_BUFFER_S)
                quality = 0;
            else if(bufferLevel > MINIMUM_BUFFER_S && bufferLevel < 2*MINIMUM_BUFFER_S){
                //compute the download time of lastQuality+1 and compare it to the buffer level
                const downloadTime = (padaState.bitrates[lastQuality]*padaState.lastFragmentDuration)/throughput;
                logger.info('downloadTime = ' + downloadTime + '  bufferLevel-downloadTime = ' + (bufferLevel-downloadTime));
                if(bufferLevel - downloadTime < MINIMUM_BUFFER_S){
                    if(throughput < padaState.bitrates[lastQuality]){
                        if(lastQuality == bitrateCount-1)
                            quality = lastQuality - 1;
                        else 
                            quality = lastQuality;
                    }else{
                        if(lastQuality != bitrateCount-1)
                            quality = lastQuality + 1;

                    } 
                }
                else{
                    if(lastQuality != bitrateCount-1)
                        quality = lastQuality + 1;
                    else    
                        quality = bitrateCount - 1;
                } 
            }
            else 
                quality = bitrateCount-1;

                    /*for(let i=0; i<bitrateCount; i++){
                        //logger.info('rates[' + i + '] = ' + rates[i]);
                        const dowloadTime = (rates[i]*padaState.lastFragmentDuration)/throughput;
                        //logger.info('download time: ' + dowloadTime);
                        //in case bufferLevel is less than Bl
                        if (bufferLevel <= MINIMUM_BUFFER_S){
                            logger.info('case bufferLevel leq MIMIMUM_BUFFER');
                            quality = 0;
                        }
                        //in case bufferLevel is higher than Bl
                        else{
                            logger.info('case bufferLevel greater than MIMIMUM_BUFFER');
                            if(bufferLevel - dowloadTime > MINIMUM_BUFFER_S){                                
                                if(rates[i] <= throughput){
                                    quality = i;
                                }
                            }
                            //else{
                            //    if(lastQuality != 0)
                            //        quality = lastQuality - 1; 
                            //} 
                            //logger.info('lastThroughput = ' + padaState.lastThroughput + '   lastQuality = ' + padaState.lastQuality);
                            //if(throughput == NaN || padaState.lastQuality == NaN)
                            //    quality = 0;
                            //if throughput is increasing
                            //else if(throughput >= padaState.lastThroughput){
                            //else if(Math.abs(padaState.lastQuality - i) <= 1){
                                //select the lowest quality > lastQuality
                            //    quality = i;
                            //}else{
                                //select lastQuality
                            //if(lastQuality >= bitrateCount-1)
                            //    quality = bitrateCount-1;
                            //else
                            //    quality = i; //padaState.lastQuality;
                            //}
                            //}
                            //otherwise, select lastQuality
                            //else 
                            //    quality = padaState.lastQuality;
                        }
                        
                    }*/
                
            
        if(quality != lastQuality)
            bitrateSwitches++;         
        logger.info('quality for priority' + prio + ' is: ' + quality);
        logger.info('bitrateswitches for priority' + prio + ' is: ' + bitrateSwitches);
        lastQuality = quality;
        //logger.info('lastQuality = ' + padaState.lastQuality);
        padaState.lastThroughput = throughput;
        return quality;        
        } 
    }

    // maximum buffer level which prefers to download at quality rather than wait
    function maxBufferLevelForQuality(padaState, quality) {
        return padaState.Vp * (padaState.utilities[quality] + padaState.gp);
    }

    // the minimum buffer level that would cause PADA to choose quality rather than a lower bitrate
    function minBufferLevelForQuality(padaState, quality) {
        const qBitrate = padaState.bitrates[quality];
        const qUtility = padaState.utilities[quality];

        let min = 0;
        for (let i = quality - 1; i >= 0; --i) {
            // for each bitrate less than bitrates[quality], PADA should prefer quality (unless other bitrate has higher utility)
            if (padaState.utilities[i] < padaState.utilities[quality]) {
                const iBitrate = padaState.bitrates[i];
                const iUtility = padaState.utilities[i];

                const level = padaState.Vp * (padaState.gp + (qBitrate * iUtility - iBitrate * qUtility) / (qBitrate - iBitrate));
                min = Math.max(min, level); // we want min to be small but at least level(i) for all i
            }
        }
        return min;
    }

    /*
     * The placeholder buffer increases the effective buffer that is used to calculate the bitrate.
     * There are two main reasons we might want to increase the placeholder buffer:
     *
     * 1. When a segment finishes downloading, we would expect to get a call on getMaxIndex() regarding the quality for
     *    the next segment. However, there might be a delay before the next call. E.g. when streaming live content, the
     *    next segment might not be available yet. If the call to getMaxIndex() does happens after a delay, we don't
     *    want the delay to change the BOLA decision - we only want to factor download time to decide on bitrate level.
     *
     * 2. It is possible to get a call to getMaxIndex() without having a segment download. The buffer target in dash.js
     *    is different for top-quality segments and lower-quality segments. If getMaxIndex() returns a lower-than-top
     *    quality, then the buffer controller might decide not to download a segment. When dash.js is ready for the next
     *    segment, getMaxIndex() will be called again. We don't want this extra delay to factor in the bitrate decision.
     */
    function updatePlaceholderBuffer(padaState, mediaType) {
        const nowMs = Date.now();

        if (!isNaN(padaState.lastSegmentFinishTimeMs)) {
            // compensate for non-bandwidth-derived delays, e.g., live streaming availability, buffer controller
            const delay = 0.001 * (nowMs - padaState.lastSegmentFinishTimeMs);
            padaState.placeholderBuffer += Math.max(0, delay);
        } else if (!isNaN(padaState.lastCallTimeMs)) {
            // no download after last call, compensate for delay between calls
            const delay = 0.001 * (nowMs - padaState.lastCallTimeMs);
            padaState.placeholderBuffer += Math.max(0, delay);
        }

        padaState.lastCallTimeMs = nowMs;
        padaState.lastSegmentStart = NaN;
        padaState.lastSegmentRequestTimeMs = NaN;
        padaState.lastSegmentFinishTimeMs = NaN;

        checkPadaStateStableBufferTime(padaState, mediaType);
    }

    function onBufferEmpty() {
        // if we rebuffer, we don't want the placeholder buffer to artificially raise PADA quality
        for (const mediaType in padaStateDict) {
            if (padaStateDict.hasOwnProperty(mediaType) && padaStateDict[mediaType].state === PADA_STATE_STEADY) {
                padaStateDict[mediaType].placeholderBuffer = 0;
            }
        }
    }

    function onPlaybackSeeking() {
        // TODO: 1. Verify what happens if we seek mid-fragment.
        // TODO: 2. If e.g. we have 10s fragments and seek, we might want to download the first fragment at a lower quality to restart playback quickly.
        for (const mediaType in padaStateDict) {
            if (padaStateDict.hasOwnProperty(mediaType)) {
                const padaState = padaStateDict[mediaType];
                if (padaState.state !== PADA_STATE_ONE_BITRATE) {
                    padaState.state = PADA_STATE_STARTUP; // TODO: BOLA_STATE_SEEK?
                    clearPadaStateOnSeek(padaState);
                }
            }
        }
    }

    function onMediaFragmentLoaded(e) {
        if (e && e.chunk && e.chunk.mediaInfo) {
            const padaState = padaStateDict[e.chunk.mediaInfo.type];
            if (padaState && padaState.state !== PADA_STATE_ONE_BITRATE) {
                const start = e.chunk.start;
                if (isNaN(padaState.mostAdvancedSegmentStart) || start > padaState.mostAdvancedSegmentStart) {
                    padaState.mostAdvancedSegmentStart = start;
                    padaState.lastSegmentWasReplacement = false;
                } else {
                    padaState.lastSegmentWasReplacement = true;
                }

                padaState.lastSegmentStart = start;
                padaState.lastSegmentDurationS = e.chunk.duration;
                padaState.lastQuality = e.chunk.quality;

                checkNewSegment(padaState, e.chunk.mediaInfo.type);
            }
        }

    }

    function onMetricAdded(e) {
        if (e && e.metric === MetricsConstants.HTTP_REQUEST && e.value && e.value.type === HTTPRequest.MEDIA_SEGMENT_TYPE && e.value.trace && e.value.trace.length) {
            const padaState = padaStateDict[e.mediaType];
            if (padaState && padaState.state !== PADA_STATE_ONE_BITRATE) {
                padaState.lastSegmentRequestTimeMs = e.value.trequest.getTime();
                padaState.lastSegmentFinishTimeMs = e.value._tfinish.getTime();
                padaState.lastSegmentFinishTime = padaState.lastSegmentFinishTimeMs;
                padaState.lastFragmentDuration = padaState.lastSegmentDurationS;
                padaState.lastRequestTimeMs = padaState.lastSegmentRequestTimeMs; 
                //logger.info('lastSegmentRequestTimeMs = ' + padaState.lastSegmentRequestTimeMs);
                //logger.info('lastSegmentFinishTimeMs = ' + padaState.lastSegmentFinishTimeMs);

                checkNewSegment(padaState, e.mediaType);
            }
        }
    }

    /*
     * When a new segment is downloaded, we get two notifications: onMediaFragmentLoaded() and onMetricAdded(). It is
     * possible that the quality for the downloaded segment was lower (not higher) than the quality indicated by BOLA.
     * This might happen because of other rules such as the DroppedFramesRule. When this happens, we trim the
     * placeholder buffer to make BOLA more stable. This mechanism also avoids inflating the buffer when BOLA itself
     * decides not to increase the quality to avoid oscillations.
     *
     * We should also check for replacement segments (fast switching). In this case, a segment is downloaded but does
     * not grow the actual buffer. Fast switching might cause the buffer to deplete, causing BOLA to drop the bitrate.
     * We avoid this by growing the placeholder buffer.
     */
    function checkNewSegment(padaState, mediaType) {
        if (!isNaN(padaState.lastSegmentStart) && !isNaN(padaState.lastSegmentRequestTimeMs) && !isNaN(padaState.placeholderBuffer)) {
            padaState.placeholderBuffer *= PLACEHOLDER_BUFFER_DECAY;

            // Find what maximum buffer corresponding to last segment was, and ensure placeholder is not relatively larger.
            if (!isNaN(padaState.lastSegmentFinishTimeMs)) {
                const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
                const bufferAtLastSegmentRequest = bufferLevel + 0.001 * (padaState.lastSegmentFinishTimeMs - padaState.lastSegmentRequestTimeMs); // estimate
                const maxEffectiveBufferForLastSegment = maxBufferLevelForQuality(padaState, padaState.lastQuality);
                const maxPlaceholderBuffer = Math.max(0, maxEffectiveBufferForLastSegment - bufferAtLastSegmentRequest);
                padaState.placeholderBuffer = Math.min(maxPlaceholderBuffer, padaState.placeholderBuffer);
            }

            // then see if we should grow placeholder buffer

            if (padaState.lastSegmentWasReplacement && !isNaN(padaState.lastSegmentDurationS)) {
                // compensate for segments that were downloaded but did not grow the buffer
                padaState.placeholderBuffer += padaState.lastSegmentDurationS;
            }

            padaState.lastSegmentStart = NaN;
            padaState.lastSegmentRequestTimeMs = NaN;
        }
    }

    function onQualityChangeRequested(e) {
        // Useful to store change requests when abandoning a download.
        if (e) {
            const padaState = padaStateDict[e.mediaType];
            if (padaState && padaState.state !== PADA_STATE_ONE_BITRATE) {
                padaState.abrQuality = e.newQuality;
            }
        }
    }

    function onFragmentLoadingAbandoned(e) {
        if (e) {
            const padaState = padaStateDict[e.mediaType];
            if (padaState && padaState.state !== PADA_STATE_ONE_BITRATE) {
                // deflate placeholderBuffer - note that we want to be conservative when abandoning
                const bufferLevel = dashMetrics.getCurrentBufferLevel(e.mediaType);
                let wantEffectiveBufferLevel;
                if (padaState.abrQuality > 0) {
                    wantEffectiveBufferLevel = minBufferLevelForQuality(padaState, padaState.abrQuality);
                } else {
                    wantEffectiveBufferLevel = MINIMUM_BUFFER_S;
                }
                const maxPlaceholderBuffer = Math.max(0, wantEffectiveBufferLevel - bufferLevel);
                padaState.placeholderBuffer = Math.min(padaState.placeholderBuffer, maxPlaceholderBuffer);
            }
        }
    }

    function getMaxIndex(rulesContext) {
        const switchRequest = SwitchRequest(context).create();

        if (!rulesContext || !rulesContext.hasOwnProperty('getMediaInfo') || !rulesContext.hasOwnProperty('getMediaType') ||
            !rulesContext.hasOwnProperty('getScheduleController') || !rulesContext.hasOwnProperty('getStreamInfo') ||
            !rulesContext.hasOwnProperty('getAbrController') || !rulesContext.hasOwnProperty('useBufferOccupancyABR')) {
            return switchRequest;
        }
        const mediaInfo = rulesContext.getMediaInfo();
        const mediaType = rulesContext.getMediaType();
        const scheduleController = rulesContext.getScheduleController();
        const streamInfo = rulesContext.getStreamInfo();
        const abrController = rulesContext.getAbrController();
        const throughputHistory = abrController.getThroughputHistory();
        const streamId = streamInfo ? streamInfo.id : null;
        const isDynamic = streamInfo && streamInfo.manifestInfo && streamInfo.manifestInfo.isDynamic;
        const useBufferOccupancyABR = rulesContext.useBufferOccupancyABR();
        
        //logger.debug('Fragment duration: ' + fragmentDur);
        switchRequest.reason = switchRequest.reason || {};

        if (!useBufferOccupancyABR) {
            return switchRequest;
        }

        scheduleController.setTimeToLoadDelay(0);

        const padaState = getPadaState(rulesContext);

        if (padaState.state === PADA_STATE_ONE_BITRATE) {
            // shouldn't even have been called
            return switchRequest;
        }

        const bufferLevel = dashMetrics.getCurrentBufferLevel(mediaType);
        const throughput = throughputHistory.getAverageThroughput(mediaType, isDynamic);
        const safeThroughput = throughputHistory.getSafeAverageThroughput(mediaType, isDynamic);
        const latency = throughputHistory.getAverageLatency(mediaType);
        let quality;

        switchRequest.reason.state = padaState.state;
        switchRequest.reason.throughput = throughput;
        switchRequest.reason.latency = latency;

        if (isNaN(throughput)) { // isNaN(throughput) === isNaN(safeThroughput) === isNaN(latency)
            // still starting up - not enough information
            return switchRequest;
        }

        switch (padaState.state) {
            case PADA_STATE_STARTUP:
                quality = abrController.getQualityForBitrate(mediaInfo, safeThroughput, streamId, latency);

                switchRequest.quality = quality;
                switchRequest.reason.throughput = safeThroughput;

                padaState.placeholderBuffer = Math.max(0, minBufferLevelForQuality(padaState, quality) - bufferLevel);
                padaState.lastQuality = quality;

                if (!isNaN(padaState.lastSegmentDurationS) && bufferLevel >= padaState.lastSegmentDurationS) {
                    padaState.state = PADA_STATE_STEADY;
                }
                lastQuality = quality;

                break; // PADA_STATE_STARTUP

            case PADA_STATE_STEADY:

                // NB: The placeholder buffer is added to bufferLevel to come up with a bitrate.
                //     This might lead BOLA to be too optimistic and to choose a bitrate that would lead to rebuffering -
                //     if the real buffer bufferLevel runs out, the placeholder buffer cannot prevent rebuffering.
                //     However, the InsufficientBufferRule takes care of this scenario.

                updatePlaceholderBuffer(padaState, mediaType);

                quality = getQualityFromBufferLevel(padaState, bufferLevel + padaState.placeholderBuffer, mediaType);

                // we want to avoid oscillations
                // We implement the "BOLA-O" variant: when network bandwidth lies between two encoded bitrate levels, stick to the lowest level.
                
                /*const qualityForThroughput = abrController.getQualityForBitrate(mediaInfo, safeThroughput, streamId, latency);
                //if (quality > padaState.lastQuality && quality > qualityForThroughput) {
                    // only intervene if we are trying to *increase* quality to an *unsustainable* level
                    // we are only avoid oscillations - do not drop below last quality

                    quality = Math.max(qualityForThroughput, padaState.lastQuality);
                }*/

                // We do not want to overfill buffer with low quality chunks.
                // Note that there will be no delay if buffer level is below MINIMUM_BUFFER_S, probably even with some margin higher than MINIMUM_BUFFER_S.
                let delayS = Math.max(0, bufferLevel + padaState.placeholderBuffer - maxBufferLevelForQuality(padaState, quality));

                // First reduce placeholder buffer, then tell schedule controller to pause.
                /*if (delayS <= padaState.placeholderBuffer) {
                    padaState.placeholderBuffer -= delayS;
                    delayS = 0;
                } else {
                    delayS -= padaState.placeholderBuffer;
                    padaState.placeholderBuffer = 0;

                    if (quality < abrController.getMaxAllowedIndexFor(mediaType, streamId)) {
                        // At top quality, allow schedule controller to decide how far to fill buffer.
                        scheduleController.setTimeToLoadDelay(1000 * delayS);
                    } else {
                        delayS = 0;
                    }
                }*/

                switchRequest.quality = quality;
                switchRequest.reason.throughput = throughput;
                switchRequest.reason.latency = latency;
                switchRequest.reason.bufferLevel = bufferLevel;
                switchRequest.reason.placeholderBuffer = padaState.placeholderBuffer;
                switchRequest.reason.delay = delayS;
                //padaState.lastThroughput = throughput;
                //padaState.lastQuality = quality;
               

                break; // PADA_STATE_STEADY

            default:
                logger.debug('PADA ABR rule invoked in bad state.');
                // should not arrive here, try to recover
                switchRequest.quality = abrController.getQualityForBitrate(mediaInfo, safeThroughput, streamId, latency);
                switchRequest.reason.state = padaState.state;
                switchRequest.reason.throughput = safeThroughput;
                switchRequest.reason.latency = latency;
                padaState.state = PADA_STATE_STARTUP;
                clearPadaStateOnSeek(padaState);
        }

        return switchRequest;
    }

    function resetInitialSettings() {
        padaStateDict = {};
    }

    function reset() {
        resetInitialSettings();

        eventBus.off(MediaPlayerEvents.BUFFER_EMPTY, onBufferEmpty, instance);
        eventBus.off(MediaPlayerEvents.PLAYBACK_SEEKING, onPlaybackSeeking, instance);
        eventBus.off(MediaPlayerEvents.METRIC_ADDED, onMetricAdded, instance);
        eventBus.off(MediaPlayerEvents.QUALITY_CHANGE_REQUESTED, onQualityChangeRequested, instance);
        eventBus.off(MediaPlayerEvents.FRAGMENT_LOADING_ABANDONED, onFragmentLoadingAbandoned, instance);

        eventBus.off(Events.MEDIA_FRAGMENT_LOADED, onMediaFragmentLoaded, instance);
    }

    instance = {
        getMaxIndex: getMaxIndex,
        reset: reset
    };

    setup();
    return instance;
}

PadaRule.__dashjs_factory_name = 'PadaRule';
export default FactoryMaker.getClassFactory(PadaRule);
