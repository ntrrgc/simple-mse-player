"use strict";
const mediaElement = document.getElementById("video");

class NetworkError extends Error {
    constructor(message) {
        super(message);
    }
}

function requestXML(url) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "document";
        xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseXML);
                } else {
                    reject(new NetworkError(`Error ${xhr.status}`));
                }
            }
        };
        xhr.send(null);
    });
}

function requestBinaryMedia(url) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.response);
                } else {
                    reject(new NetworkError(`Error ${xhr.status}`));
                }
            }
        };
        xhr.send(null);
    })
}

function xpathIterator(doc, node, expression) {
    function nsResolver(prefix) {
        return prefix === "mpd" ? "urn:mpeg:dash:schema:mpd:2011" : null;
    }

    return doc.evaluate(expression, node, nsResolver);
}

function xpathList(doc, node, expression) {
    const iter = xpathIterator(doc, node, expression);
    const ret = [];
    let next;
    while (next = iter.iterateNext()) {
        ret.push(next);
    }
    return ret;
}

function xpathSingle(doc, node, expression) {
    const list = xpathList(doc, node, expression);
    if (list.length === 1) {
        return list[0];
    } else if (list.length === 0) {
        throw new Error(`Could not find XPath: ${expression}`)
    } else {
        throw new Error(`Several unexpected matches when searching XPath: ${expression}`);
    }
}

function pad(num, size) {
    let ret = num + "";
    while (ret.length < size) {
        ret = "0" + ret;
    }
    return ret;
}

function waitMilliseconds(number) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, number);
    })
}

function formatTimeSeconds(time, includeFraction) {
    const hours = Math.floor(time / 3600);
    const minutes = Math.floor((time / 60) % 60);
    const seconds = Math.floor(time % 60);
    const nanosecondsFractionString = includeFraction ? "." + time.toFixed(9).replace(/^.*\./, "") : "";
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}${nanosecondsFractionString}`;
}

class AdaptationSetFeeder {
    constructor(mediaElement, mediaSource, mpdPath, mpd, adaptationSet) {
        this.mediaElement = mediaElement;
        const container = this.container = adaptationSet.getAttribute("mimeType");
        const representation = xpathSingle(mpd, adaptationSet, "./mpd:Representation");
        const codec = representation.getAttribute("codecs");
        this.sourceBuffer = mediaSource.addSourceBuffer(`${container};codecs="${codec}"`);

        this.representationId = representation.getAttribute("id");

        const segmentTemplate = xpathSingle(mpd, adaptationSet, "./mpd:SegmentTemplate");
        this.initializationSegmentPath = AdaptationSetFeeder.resolvePath(mpdPath,
            segmentTemplate.getAttribute("initialization").replace("$RepresentationID$", this.representationId))

        // Parse segment list

        this.timescale = segmentTemplate.getAttribute("timescale");
        const startNumber = parseInt(segmentTemplate.getAttribute("startNumber"));
        const mediaTemplate = segmentTemplate.getAttribute("media")
            .replace("$RepresentationID$", this.representationId);

        let number = startNumber;
        let accumulatedTimeUnits = 0;
        this.segmentTable = [];
        for (let segmentNode of xpathList(mpd, adaptationSet, "./mpd:SegmentTemplate/mpd:SegmentTimeline/mpd:S")) {
            const repeatCount = segmentNode.hasAttribute("r") ? parseInt(segmentNode.getAttribute("r")) : 0;

            for (let repetition = 0; repetition <= repeatCount; ++repetition) {
                const path = AdaptationSetFeeder.resolvePath(mpdPath,
                    mediaTemplate.replace("$Number$", number.toString()));
                const start = accumulatedTimeUnits;
                const duration = parseInt(segmentNode.getAttribute("d"));
                const end = accumulatedTimeUnits + duration;
                this.segmentTable.push({
                    start: start,
                    duration: duration,
                    end: end,
                    path: path,
                });

                accumulatedTimeUnits = end;
                number++;
            }
        }

        this.mainAsync()
    }

    static resolvePath(mpdPath, relativePath) {
        return mpdPath.replace(/\/[^/]+$/, "") + "/" + relativePath;
    }

    formatTimeUnits(timeUnits) {
        return formatTimeSeconds(timeUnits / this.timescale);
    }

    async mainAsync() {
        let initializationSegment;
        try {
            initializationSegment = await requestBinaryMedia(this.initializationSegmentPath);
        } catch (err) {
            if (err instanceof NetworkError) {
                this.sourceBuffer.endOfStream("network");
                console.error(err);
                return;
            } else {
                throw err;
            }
        }

        this.sourceBuffer.appendBuffer(initializationSegment);
        initializationSegment = null; // free memory

        for (let segment of this.segmentTable) {
            const segmentBlob = await requestBinaryMedia(segment.path);
            await this.updateEnded();
            while (true) {
                try {
                    this.sourceBuffer.appendBuffer(segmentBlob);
                    break;
                } catch (ex) {
                    if (ex instanceof DOMException && ex.name == "QuotaExceededError") {
                        console.log("QuotaExceeded");
                        await waitMilliseconds(5000);
                    } else {
                        throw ex;
                    }
                }
            }
        }
    }

    updateEnded() {
        return new Promise(resolve => {
            if (!this.sourceBuffer.updating) {
                resolve();
            } else {
                const self = this;
                // noinspection JSAnnotator
                function onUpdateEndHandler() {
                    self.sourceBuffer.removeEventListener("updateend", onUpdateEndHandler);
                    resolve();
                }
                this.sourceBuffer.addEventListener("updateend", onUpdateEndHandler);
            }
        });
    }
}

async function parseManifest(mediaElement, mediaSource, mpdPath) {
    mpd = await requestXML(mpdPath);
    feeders = [];
    for (let adaptationSet of xpathList(mpd, mpd, "/mpd:MPD/mpd:Period[1]/mpd:AdaptationSet")) {
        feeders.push(new AdaptationSetFeeder(mediaElement, mediaSource, mpdPath, mpd, adaptationSet));
    }
}

let mpd, feeders;
const mediaSource = new MediaSource();
mediaSource.onsourceopen = function onsourceopen() {
    parseManifest(mediaElement, mediaSource, "dash/stream.mpd")
        .then(() => {})
};
mediaElement.src = window.URL.createObjectURL(mediaSource);

function formatRanges(sourceBuffer) {
    let ranges = [];
    for (let i = 0; i < sourceBuffer.buffered.length; i++) {
        ranges.push(`${formatTimeSeconds(sourceBuffer.buffered.start(i))}-${formatTimeSeconds(sourceBuffer.buffered.end(i))}`);
    }
    return ranges.join(" ");
}

setInterval(() => {
    if (!feeders)
        return;
    console.log(feeders.map(feeder => `${feeder.container.padEnd(10)}: ${formatRanges(feeder.sourceBuffer)}`).join("\n"));
}, 2000);