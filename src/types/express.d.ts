import { ObjectId } from "mongodb";


declare global{
    namespace Express{
        interface Request{
            session?:{
                sessionId: string
                userId: string
                expiresAt: Date
            }
        }
    }
}