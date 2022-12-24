# TRACTION Pre-Recorded Content Adaptation Algorithm

This repository contains the code of the Pre-Recorded Content Adaptation Algorithm for the TRACTION EU-project. It is used to select the appropriate bitrates during on-demand content streaming to guarantee viewers’ good QoE. It considers differents parameters such as bandwidth, buffer level, quality variation, and stream priority. It tries to ensure the highest bitrate for audio, a key feature for performing arts pieces (opera in particular), while adapting the video quality given the bandwidth constraints. This is because many studies have shown that ensuring high audio quality can have a positive impact on viewers' QoE.

<img src="https://www.traction-project.eu/wp-content/uploads/sites/3/2020/02/Logo-cabecera-Traction.png" align="left"/><em>This tool was originally developed as part of the <a href="https://www.traction-project.eu/">TRACTION</a> project, funded by the European Commission’s <a hef="http://ec.europa.eu/programmes/horizon2020/">Horizon 2020</a> research and innovation programme under grant agreement No. 870610.</em>

## Documentation

The documentation is available here: https://traction-project.github.io/PreRecordedContentAdaptation

## Setup

The TRACTION Pre-Recorded Content Adaptation Algorithm is deployed within the <a href=https://github.com/Dash-Industry-Forum/dash.js?>dash.js reference player</a> under `/PreRecordedContentAdaptation/src/streaming/rules/abr`. The file containing the algorithm's logic is `PadaRule.js`. 

To use the Pre-Recorded Content Adaptation Algorithm, first you need to create a video element on your html file. Make sure the controls attribute is present. 
```html
<video id="videoPlayer" controls></video>
```
Add dash.all.min.js to the end of the body.
```html
<body>
  ...
  <script src="yourPathToDash/dash.all.min.js"></script>
</body>
```
Now, create a MediaPlayer and initialise it. The `url` attribute should contain the link to the mpd of your video.
``` js
var url = "https://PathToYourMPD/manifest.mpd";
var player = dashjs.MediaPlayer().create();
player.initialize(document.querySelector("#videoPlayer"), url, true);
```
To make the player use the Pre-Recorded Content Adaptation Algorthim, Labelled as `abrPada`, you need to update the player's settings, particularly those related to `abr`. 
``` js
player.updateSettings({
    'abr':{
        'ABRStrategy' : 'abrPada',
        'priority'    : 3,
    }
});
```
Note that `priority` denotes the priority of the stream. It's mainly used for multi-streaming use cases. It has 3 values: high (3), medium (2), and low (1). 

Once done, your html file should look like the following: 
```html
<!doctype html>
<html>
    <head>
        <title>My html</title>
        <style>
            video {
                width: 640px;
                height: 360px;
            }
        </style>
    </head>
    <body>
        <div>
            <video id="videoPlayer" controls></video>
        </div>
        <script src="yourPathToDash/dash.all.min.js"></script>
        <script>
            (function(){
                var url = "https://PathToYourMPD/manifest.mpd";
                var player = dashjs.MediaPlayer().create();
                player.initialize(document.querySelector("#videoPlayer"), url, true);
          
                player.updateSettings({
                  'abr':{
                        'ABRStrategy' : 'abrPada',
                        'priority'    : 3,
                   }
                });
            })();
        </script>
    </body>
</html>
```

## Data Collection

The dash player enables the collection of some QoS metrics such as buffer level, throughput, and selected bitrate. 
``` js
var bufferLevel = player.getBufferLength('type');
var throughput  = player.getAverageThroughput('type');
var quality     = player.getQualityFor('type');
```
`type` denotes the segment type (i.e., video, audio). These metrics along with others can help assess the adaptation algorithm. 

## Adding/ modifying the Pre-Recorded Content Adaptation Algorithm

To be able to add or modify `PadaRule.js`, you need to do the following steps: 

1. Install [node.js](http://nodejs.org/).
2. Checkout the project repository (```git clone https://github.com/traction-project/PreRecordedContentAdaptation.git```). 
3. Install dependencies (```npm install```). 
4. Add or make changes to `PadaRule.js`.  
5. Build, watch file changes, and launch samples page (```npm run start```).

## dash.js Documentation

Full [API Documentation](http://cdn.dashjs.org/latest/jsdoc/module-MediaPlayer.html) is available describing all public methods, interfaces, properties, and events.

For help, join [Slack channel](https://dashif-slack.azurewebsites.net) or the [email list](https://groups.google.com/d/forum/dashjs). 
