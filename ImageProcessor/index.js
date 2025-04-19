const axios = require('axios');
const sharp = require('sharp');

module.exports = async function (context, req) {
    context.log('Traitement d\'image démarré');

    try {
        if (!req.body || !req.body.imageUrl) {
            context.res = {
                status: 400,
                body: { message: "L'URL de l'image est requise dans le corps de la requête" }
            };
            return;
        }

        const imageUrl = req.body.imageUrl;
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(imageResponse.data, 'binary');
        const metadata = await sharp(imageBuffer).metadata();

        const visionApiKey = process.env.VISION_API_KEY;
        const visionEndpoint = process.env.VISION_ENDPOINT;

        if (!visionApiKey || !visionEndpoint) {
            context.res = {
                status: 500,
                body: { message: "Configuration Azure Vision manquante" }
            };
            return;
        }

        const visionResponse = await axios.post(
            `${visionEndpoint}/vision/v3.2/read/analyze`,
            imageBuffer,
            {
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'Ocp-Apim-Subscription-Key': visionApiKey
                }
            }
        );

        const operationLocation = visionResponse.headers['operation-location'];
        let analyzeResult = null;
        let status = '';

        while (status !== 'succeeded') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const resultResponse = await axios.get(operationLocation, {
                headers: {
                    'Ocp-Apim-Subscription-Key': visionApiKey
                }
            });
            status = resultResponse.data.status;
            if (status === 'succeeded') {
                analyzeResult = resultResponse.data;
            }
        }

        let upperBound = null;
        let lowerBound = null;

        if (analyzeResult?.analyzeResult?.readResults) {
            const readResults = analyzeResult.analyzeResult.readResults;
            const textLines = [];

            readResults.forEach(page => {
                page.lines?.forEach(line => {
                    textLines.push({
                        text: line.text,
                        y: line.boundingBox[1],
                        height: line.boundingBox[7] - line.boundingBox[1]
                    });
                });
            });

            const upperPhrases = ["Analysez les problèmes", "Analyse des performances"];
            const lowerPhrases = ["STATISTIQUES", "Développer la vue", "Les valeurs sont estimées"];

            for (const phrase of upperPhrases) {
                const match = textLines.find(line => line.text.includes(phrase));
                if (match) {
                    upperBound = match.y;
                    break;
                }
            }

            const lowerLines = textLines.filter(line => line.y > metadata.height * 0.7);
            for (const phrase of lowerPhrases) {
                const match = lowerLines.find(line => line.text.includes(phrase));
                if (match) {
                    lowerBound = match.y + 200;
                    break;
                }
            }

            if (!upperBound) upperBound = metadata.height * 0.15;
            if (!lowerBound) lowerBound = metadata.height * 0.85;
            if (lowerBound <= upperBound) lowerBound = metadata.height * 0.85;
        }

        const croppedImage = await sharp(imageBuffer)
            .extract({
                left: 0,
                top: Math.round(upperBound),
                width: metadata.width,
                height: Math.round(lowerBound - upperBound)
            })
            .toBuffer();

        const base64Image = croppedImage.toString('base64');

        context.res = {
            status: 200,
            body: {
                processedImage: base64Image,
                metadata: {
                    originalWidth: metadata.width,
                    originalHeight: metadata.height,
                    croppedWidth: metadata.width,
                    croppedHeight: Math.round(lowerBound - upperBound),
                    upperBound: Math.round(upperBound),
                    lowerBound: Math.round(lowerBound)
                }
            }
        };
    } catch (error) {
        context.log.error('Erreur lors du traitement de l\'image:', error);
        context.res = {
            status: 500,
            body: { message: "Erreur lors du traitement de l'image", error: error.message }
        };
    }
};
