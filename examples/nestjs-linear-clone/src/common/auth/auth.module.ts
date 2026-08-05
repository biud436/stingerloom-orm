import { Module, Global } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule, JwtSignOptions } from "@nestjs/jwt";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { User } from "../../modules/users/user.entity";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { WorkspaceMemberGuard } from "./workspace-member.guard";

@Global()
@Module({
  imports: [
    StingerloomOrmModule.forFeature([User]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>("JWT_SECRET"),
        signOptions: {
          // jsonwebtoken 9 (via @nestjs/jwt 11) types expiresIn as
          // `number | ms.StringValue`; env values arrive as plain strings.
          expiresIn: (config.get<string>("JWT_EXPIRES_IN") ??
            "1h") as JwtSignOptions["expiresIn"],
          issuer: "linear-clone",
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, WorkspaceMemberGuard],
  exports: [JwtAuthGuard, WorkspaceMemberGuard, JwtModule, AuthService],
})
export class AuthModule {}
