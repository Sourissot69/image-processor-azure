const axios = require('axios');
const sharp = require('sharp');

module.exports = async function (context, req) {
    context.log('Traitement d\'image démarré');

    try {
        // Vérifier si une image est bien fournie dans la requête
        if (!req.body || !req.body.imageUrl) {
            context.res = {
                status: 400,
                body: { message: "L'URL de l'image est requise dans le corps de la requête" }
            };
            return;
        }

        const imageUrl = req.body.imageUrl;
        
        // Récupérer l'image depuis l'URL
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const imageBuffer = Buffer.from(imageResponse.data, 'binary');
        
        // Obtenir les métadonnées de l'image
        const metadata = await sharp(imageBuffer).metadata();
        
        // Appel à Azure Computer Vision pour analyser l'image
        const visionApiKey = process.env.VISION_API_KEY;
        const visionEndpoint = process.env.VISION_ENDPOINT;
        
        if (!visionApiKey || !visionEndpoint) {
            context.res = {
                status: 500,
                body: { message: "Configuration Azure Vision manquante" }
            };
            return;
        }
        
        // Appel à l'API Azure Computer Vision pour la reconnaissance de texte
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
        
        // Récupérer l'URL de résultat fournie par l'API
        const operationLocation = visionResponse.headers['operation-location'];
        
        // Attendre que l'analyse soit terminée
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
        
        // Traiter les résultats d'analyse
        let upperBound = null;
        let lowerBound = null;
        
        if (analyzeResult && analyzeResult.analyzeResult && analyzeResult.analyzeResult.readResults) {
            const readResults = analyzeResult.analyzeResult.readResults;
            const textLines = [];
            
            // Extraire toutes les lignes de texte
            readResults.forEach(page => {
                if (page.lines) {
                    page.lines.forEach(line => {
                        textLines.push({
                            text: line.text,
                            y: line.boundingBox[1], // Position Y
                            height: line.boundingBox[7] - line.boundingBox[1]
                        });
                    });
                }
            });
            
            // Rechercher les phrases spécifiques pour déterminer les limites
            const upperPhrases = ["Analysez les problèmes", "Analyse des performances"];
            const lowerPhrases = ["STATISTIQUES", "Développer la vue", "Les valeurs sont estimées"];
            
            // Trouver la limite supérieure
            for (const phrase of upperPhrases) {
                const matchingLine = textLines.find(line => line.text.includes(phrase));
                if (matchingLine) {
                    upperBound = matchingLine.y;
                    break;
                }
            }
            
            // Trouver la limite inférieure (chercher dans le dernier tiers de l'image)
            const imageThirdY = metadata.height * 0.7;
            const lowerLines = textLines.filter(line => line.y > imageThirdY);
            
            for (const phrase of lowerPhrases) {
                const matchingLine = lowerLines.find(line => line.text.includes(phrase));
                if (matchingLine) {
                    // Position 200 pixels sous le texte trouvé
                    lowerBound = matchingLine.y + 200;
                    break;
                }
            }
            
            // Valeurs par défaut si les phrases n'ont pas été trouvées
            if (!upperBound) upperBound = metadata.height * 0.15;
            if (!lowerBound) lowerBound = metadata.height * 0.85;
            
            // S'assurer que la limite inférieure est bien après la limite supérieure
            if (lowerBound <= upperBound) {
                lowerBound = metadata.height * 0.85;
            }
        }
        
        // Découper l'image
        const croppedImage = await sharp(imageBuffer)
            .extract({
                left: 0,
                top: Math.round(upperBound),
                width: metadata.width,
                height: Math.round(lowerBound - upperBound)
            })
            .toBuffer();
        
        // Retourner l'image découpée en Base64
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
