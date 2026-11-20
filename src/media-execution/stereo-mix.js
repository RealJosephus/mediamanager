// Coefficients and layout names from Jellyfin's DownMixAlgorithmsHelper,
// designated source 208c278b75abd897aefa1e1175126eac5e4dbfaa (GPL-2.0).
const mixes = {
  "Dave750": {
    "5.1": "pan=stereo|c0=0.5*c2+0.707*c0+0.707*c4+0.5*c3|c1=0.5*c2+0.707*c1+0.707*c5+0.5*c3",
    "7.1": "pan=5.1(side)|c0=c0|c1=c1|c2=c2|c3=c3|c4=0.707*c4+0.707*c6|c5=0.707*c5+0.707*c7,pan=stereo|c0=0.5*c2+0.707*c0+0.707*c4+0.5*c3|c1=0.5*c2+0.707*c1+0.707*c5+0.5*c3"
  },
  "NightmodeDialogue": {
    "5.1": "pan=stereo|c0=c2+0.30*c0+0.30*c4|c1=c2+0.30*c1+0.30*c5",
    "7.1": "pan=5.1(side)|c0=c0|c1=c1|c2=c2|c3=c3|c4=0.707*c4+0.707*c6|c5=0.707*c5+0.707*c7,pan=stereo|c0=c2+0.30*c0+0.30*c4|c1=c2+0.30*c1+0.30*c5"
  },
  "Rfc7845": {
    "3.0": "pan=stereo|c0=0.414214*c2+0.585786*c0|c1=0.414214*c2+0.585786*c1",
    "quad": "pan=stereo|c0=0.422650*c0+0.366025*c2+0.211325*c3|c1=0.422650*c1+0.366025*c3+0.211325*c2",
    "5.0": "pan=stereo|c0=0.460186*c2+0.650802*c0+0.563611*c3+0.325401*c4|c1=0.460186*c2+0.650802*c1+0.563611*c4+0.325401*c3",
    "5.1": "pan=stereo|c0=0.374107*c2+0.529067*c0+0.458186*c4+0.264534*c5+0.374107*c3|c1=0.374107*c2+0.529067*c1+0.458186*c5+0.264534*c4+0.374107*c3",
    "6.1": "pan=stereo|c0=0.321953*c2+0.455310*c0+0.394310*c5+0.227655*c6+0.278819*c4+0.321953*c3|c1=0.321953*c2+0.455310*c1+0.394310*c6+0.227655*c5+0.278819*c4+0.321953*c3",
    "7.1": "pan=stereo|c0=0.274804*c2+0.388631*c0+0.336565*c6+0.194316*c7+0.336565*c4+0.194316*c5+0.274804*c3|c1=0.274804*c2+0.388631*c1+0.336565*c7+0.194316*c6+0.336565*c5+0.194316*c4+0.274804*c3"
  },
  "Ac4": {
    "3.0": "pan=stereo|c0=c0+0.707*c2|c1=c1+0.707*c2",
    "5.0": "pan=stereo|c0=c0+0.707*c2+0.707*c3|c1=c1+0.707*c2+0.707*c4",
    "5.1": "pan=stereo|c0=c0+0.707*c2+0.707*c4|c1=c1+0.707*c2+0.707*c5",
    "7.0": "pan=5.0(side)|c0=c0|c1=c1|c2=c2|c3=0.707*c3+0.707*c5|c4=0.707*c4+0.707*c6,pan=stereo|c0=c0+0.707*c2+0.707*c3|c1=c1+0.707*c2+0.707*c4",
    "7.1": "pan=5.1(side)|c0=c0|c1=c1|c2=c2|c3=c3|c4=0.707*c4+0.707*c6|c5=0.707*c5+0.707*c7,pan=stereo|c0=c0+0.707*c2+0.707*c4|c1=c1+0.707*c2+0.707*c5"
  }
};

const inferredLayouts = ['', 'mono', 'stereo', '2.1', '4.0', '5.0', '5.1', '6.1', '7.1'];

export function stereoMix(algorithm, stream) {
  const layout = stream.ChannelLayout?.trim() ? stream.ChannelLayout : inferredLayouts[stream.Channels];
  return mixes[algorithm]?.[layout];
}
